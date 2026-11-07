using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using Microsoft.Win32.SafeHandles;

namespace Capri.ProcessSupervisor;

internal static class Program
{
    private const uint FailureExit = 125;
    private const uint Infinite = 0xffffffff;
    private const uint CreateSuspended = 0x00000004;
    private const uint CreateNoWindow = 0x08000000;
    private const uint ExtendedStartupInfoPresent = 0x00080000;
    private const uint UseStdHandles = 0x00000100;
    private const uint KillOnJobClose = 0x00002000;

    public static int Main(string[] args)
    {
        if (!OperatingSystem.IsWindows()) return Fail("Windows is required");
        try
        {
            if (args.Length == 10 && args[0] == "--control-message" && args[2] == "--token" && args[4] == "--binding" && args[6] == "--kind" && args[8] == "--deadline")
                return ControlLedger.PublishMessage(args[1], args[3], args[5], args[7], args[9]);
            string? directory = null, token = null;
            int offset = 0;
            if (args.Length >= 4 && args[0] == "--control" && args[2] == "--token")
            { directory = args[1]; token = args[3]; offset = 4; }
            if (args.Length < offset + 2 || args[offset] != "--" || !Path.IsPathFullyQualified(args[offset + 1]) || args.Any(arg => arg.Contains('\0')))
                return Fail("expected optional control binding and -- followed by an absolute executable path and optional arguments");
            return Run(args.Skip(offset + 1).ToArray(), directory, token);
        }
        catch (SupervisorFailure failure) { return Fail(failure.Message); }
        catch { return Fail("operation failed"); } // Never log paths, command lines, environment, or stdin.
    }

    private static int Fail(string message)
    {
        try { Console.Error.WriteLine("ProcessSupervisor: " + message + "."); }
        catch (IOException) { /* The creating process may have closed its pipe. */ }
        return unchecked((int)FailureExit);
    }

    private static int Run(string[] argv, string? directory, string? token)
    {
        using var owner = OpenCreatingProcess();
        string executable = Path.GetFullPath(argv[0]);
        bool console = IsConsoleExecutable(executable);
        string command = string.Join(" ", argv.Select(QuoteArgument));
        if (command.Length >= 32767) throw new SupervisorFailure("command line is too long");

        // No name and no inheritable security attributes. Only this process owns
        // the job handle; forced supervisor death therefore kills the entire job.
        using var job = Native.CreateJobObjectW(IntPtr.Zero, null);
        Require(!job.IsInvalid, "job creation");
        var limits = new ExtendedLimitInformation { Basic = new BasicLimitInformation { LimitFlags = KillOnJobClose } };
        Require(Native.SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf<ExtendedLimitInformation>()), "job limits");
        using var ledger = directory is null ? null : new ControlLedger(directory, token!, argv, owner);
        try
        {
            // The host durably captures this guardian's exact public binding
            // before acknowledging. No delegated instruction runs before that.
            ledger?.Arm();
            string? early = ledger?.AwaitAcknowledgement(owner);
            if (early is not null)
            {
                DrainJob(job); ledger!.Complete(job, early, null);
                throw new SupervisorFailure("owned launch cancelled before dispatch");
            }
            ledger?.RequireDispatchAllowed(owner);
            ProcessInformation created;
            using (var inherited = new StandardHandles(job))
            {
                var startup = inherited.Startup;
                uint flags = CreateSuspended | ExtendedStartupInfoPresent | (console ? CreateNoWindow : 0);
                // STARTF_USESHOWWINDOW stays absent: GUI fixtures remain visible.
                Require(Native.CreateProcessW(executable, new StringBuilder(command), IntPtr.Zero, IntPtr.Zero,
                    true, flags, IntPtr.Zero, null, ref startup, out created), "process creation");
            }
            using var process = new KernelHandle(created.Process);
            using var thread = new KernelHandle(created.Thread);
            // User code has not executed yet. Assignment failure kills exactly
            // the created immutable handle; no PID lookup or process-tree race.
            if (!Native.IsProcessInJob(process, job, out bool inJob) || !inJob)
            {
                int error = Marshal.GetLastWin32Error();
                Require(Native.TerminateProcess(process, FailureExit), "unassigned process termination");
                Require(Native.WaitForSingleObject(process, 10000) == 0, "unassigned process exit");
                throw new SupervisorFailure("job assignment failed (Win32 " + error + ")");
            }
            RequireOwnerAlive(owner);
            ledger?.RequireDispatchAllowed(owner);
            Require(Native.ResumeThread(thread) != uint.MaxValue, "primary thread resume");
            uint completed;
            bool cancelled = false;
            do
            {
                cancelled = ledger?.CancellationRequested() == true;
                if (cancelled) break;
                completed = Native.WaitForMultipleObjects(2,
                    new[] { owner.DangerousGetHandle(), process.DangerousGetHandle() }, false, ledger is null ? Infinite : 50);
                if (completed != 258) break;
            } while (true);
            completed = cancelled ? 2 : Native.WaitForMultipleObjects(2,
                new[] { owner.DangerousGetHandle(), process.DangerousGetHandle() }, false, 0);
            GC.KeepAlive(owner);
            GC.KeepAlive(process);
            Require(completed is 0 or 1 or 2, "owner/main process wait");
            if (completed == 2)
            {
                DrainJob(job); ledger!.Complete(job, "cancelled", null);
                return unchecked((int)FailureExit);
            }
            if (completed == 0)
            {
                DrainJob(job); ledger?.Complete(job, "creator-exited", null);
                throw new SupervisorFailure("creating process exited; owned processes terminated");
            }
            Require(Native.GetExitCodeProcess(process, out uint exitCode), "main exit status");
            DrainJob(job); ledger?.Complete(job, "main-exited", exitCode);
            return unchecked((int)exitCode);
        }
        catch
        {
            // This path is also fail-closed if resume/wait/query fails. Job
            // disposal remains the final OS-enforced cleanup on every exit.
            DrainJob(job);
            ledger?.Complete(job, "guardian-error", null);
            throw;
        }
    }

    private static KernelHandle OpenCreatingProcess()
    {
        IntPtr current = Native.GetCurrentProcess();
        int status = Native.NtQueryInformationProcess(current, 0, out var basic,
            (uint)Marshal.SizeOf<ProcessBasicInformation>(), out uint returned);
        if (status != 0 || returned != Marshal.SizeOf<ProcessBasicInformation>() ||
            basic.ProcessId != (nuint)Environment.ProcessId || basic.ParentProcessId == 0 ||
            basic.ParentProcessId > uint.MaxValue || basic.ParentProcessId == basic.ProcessId)
            throw new SupervisorFailure("creating process identity could not be established");

        // This is the kernel-recorded creator, never a command-line/environment
        // PID. Open once with wait/query rights only; never terminate the owner.
        var owner = Native.OpenProcess(0x00101000, false, (uint)basic.ParentProcessId);
        try
        {
            Require(!owner.IsInvalid, "creating process handle");
            Require(Native.GetProcessTimes(owner.DangerousGetHandle(), out var ownerCreated,
                out _, out _, out _), "creating process creation time");
            Require(Native.GetProcessTimes(current, out var selfCreated, out _, out _, out _), "supervisor creation time");
            // A replacement for an already-exited creator PID must have been
            // created after this supervisor. Reject it instead of monitoring an
            // unrelated process; the pinned handle cannot subsequently be reused.
            if (ownerCreated.Value == 0 || selfCreated.Value == 0 || ownerCreated.Value > selfCreated.Value)
                throw new SupervisorFailure("creating process identity changed");
            RequireOwnerAlive(owner);
            return owner;
        }
        catch { owner.Dispose(); throw; }
    }

    private static void RequireOwnerAlive(KernelHandle owner)
    {
        uint state = Native.WaitForSingleObject(owner, 0);
        if (state == 0) throw new SupervisorFailure("creating process has already exited");
        Require(state == 258, "creating process status");
    }

    private static void DrainJob(KernelHandle job)
    {
        if (ActiveProcesses(job) != 0) Require(Native.TerminateJobObject(job, FailureExit), "remaining process termination");
        var deadline = Stopwatch.StartNew();
        while (ActiveProcesses(job) != 0)
        {
            if (deadline.ElapsedMilliseconds >= 10000) throw new SupervisorFailure("owned process exit was not confirmed");
            Thread.Sleep(10);
        }
    }

    private static uint ActiveProcesses(KernelHandle job)
    {
        Require(Native.QueryInformationJobObject(job, 1, out var accounting,
            (uint)Marshal.SizeOf<BasicAccountingInformation>(), IntPtr.Zero), "job accounting");
        return accounting.ActiveProcesses;
    }

    // Always quote each argv element using the Windows CRT backslash/quote
    // convention. lpApplicationName separately pins the executable; no shell or
    // operator-provided command string is interpreted here.
    private static string QuoteArgument(string value)
    {
        var result = new StringBuilder("\"");
        int slashes = 0;
        foreach (char character in value)
        {
            if (character == '\\') { slashes++; continue; }
            if (character == '"') result.Append('\\', slashes * 2 + 1).Append('"');
            else result.Append('\\', slashes).Append(character);
            slashes = 0;
        }
        return result.Append('\\', slashes * 2).Append('"').ToString();
    }

    private static bool IsConsoleExecutable(string executable)
    {
        try
        {
            if (!string.Equals(Path.GetExtension(executable), ".exe", StringComparison.OrdinalIgnoreCase))
                throw new SupervisorFailure("target must be a Windows executable");
            using var reader = new BinaryReader(File.Open(executable, FileMode.Open, FileAccess.Read, FileShare.Read | FileShare.Delete));
            if (reader.BaseStream.Length < 64 || reader.ReadUInt16() != 0x5a4d) throw new SupervisorFailure("invalid executable format");
            reader.BaseStream.Position = 0x3c;
            int offset = reader.ReadInt32();
            if (offset < 64 || offset > reader.BaseStream.Length - 94) throw new SupervisorFailure("invalid executable format");
            reader.BaseStream.Position = offset;
            if (reader.ReadUInt32() != 0x00004550) throw new SupervisorFailure("invalid executable format");
            reader.BaseStream.Position = offset + 20;
            if (reader.ReadUInt16() < 70) throw new SupervisorFailure("invalid executable header");
            reader.BaseStream.Position = offset + 24;
            ushort magic = reader.ReadUInt16();
            if (magic is not (0x10b or 0x20b)) throw new SupervisorFailure("unsupported executable format");
            reader.BaseStream.Position = offset + 24 + 68;
            return reader.ReadUInt16() switch
            {
                3 => true,
                2 => false,
                _ => throw new SupervisorFailure("unsupported executable subsystem")
            };
        }
        catch (SupervisorFailure) { throw; }
        catch { throw new SupervisorFailure("executable validation failed"); }
    }

    private static void Require(bool success, string operation)
    {
        if (!success) throw new SupervisorFailure(operation + " failed (Win32 " + Marshal.GetLastWin32Error() + ")");
    }

    private sealed class SupervisorFailure(string message) : Exception(message);

    // This is a per-run, user-private sidechannel, never a global service or a
    // named Job lookup. The Job remains unnamed and has exactly one handle.
    // A pinned ephemeral public key authenticates only terminal zero-job proof;
    // the private key never leaves this guardian or reaches inherited handles.
    private sealed class ControlLedger : IDisposable
    {
        private readonly string directory, token, requestHash;
        private readonly FileStream request, claim;
        private readonly KernelHandle directoryHandle;
        private readonly ECDsa signer = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        private readonly Dictionary<string, object?> binding;
        private FileStream? armed;
        private string? armedHash;
        private bool completed;
        private long acknowledgedDeadline;
        private static readonly string[] requestFields = ["schemaVersion", "token", "scopeSha256", "helperPath", "helperSha256", "creatorPid", "cwdSha256", "commandSha256"];

        public ControlLedger(string proposedDirectory, string proposedToken, string[] argv, KernelHandle owner)
        {
            if (!Hex(proposedToken) || !Path.IsPathFullyQualified(proposedDirectory)) throw new SupervisorFailure("invalid control binding");
            directory = CheckedPath(proposedDirectory, true);
            token = proposedToken;
            string cwd = CheckedPath(Directory.GetCurrentDirectory(), true);
            if (Path.GetFileName(directory) != token || Contains(cwd, directory) || Contains(directory, cwd)) throw new SupervisorFailure("control directory overlaps delegated workspace");
            if (!Directory.EnumerateFileSystemEntries(directory).Select(Path.GetFileName).Order().SequenceEqual(new[] { "request.json" })) throw new SupervisorFailure("control directory is not a fresh prepared run");
            var current = WindowsIdentity.GetCurrent().User ?? throw new SupervisorFailure("current user identity unavailable");
            var info = new DirectoryInfo(directory);
            var security = info.GetAccessControl(AccessControlSections.Owner);
            if (!current.Equals(security.GetOwner(typeof(SecurityIdentifier)))) throw new SupervisorFailure("control directory owner changed");
            var restricted = new DirectorySecurity();
            restricted.SetOwner(current); restricted.SetAccessRuleProtection(true, false);
            restricted.AddAccessRule(new FileSystemAccessRule(current, FileSystemRights.FullControl, InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
            restricted.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null), FileSystemRights.FullControl, InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
            info.SetAccessControl(restricted);
            // Pin the run directory without DELETE sharing, preventing redirection
            // or rename while this guardian owns its Job and proof files.
            directoryHandle = Native.CreateFileW(directory, 0x80000000, 3, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero);
            Require(!directoryHandle.IsInvalid, "control directory handle");
            FileStream? opened = null, claimed = null;
            try
            {
                opened = ReadLocked(Path.Combine(directory, "request.json"));
                byte[] bytes = ReadBytes(opened); requestHash = Hash(bytes);
                using var document = JsonDocument.Parse(bytes);
                var value = document.RootElement;
                if (!Exact(value, requestFields) || value.GetProperty("schemaVersion").GetInt32() != 1 || Text(value, "token") != token || !Hex(Text(value, "scopeSha256")) || !Hex(Text(value, "helperSha256")) || !Hex(Text(value, "cwdSha256")) || !Hex(Text(value, "commandSha256"))) throw new SupervisorFailure("invalid prepared control record");
                string helper = CheckedPath(Environment.ProcessPath!, false), expectedHelper = Text(value, "helperPath");
                uint creator = Native.GetProcessId(owner);
                Require(Native.GetProcessTimes(owner.DangerousGetHandle(), out var creatorCreated, out _, out _, out _), "control creator identity");
                Require(Native.GetProcessTimes(Native.GetCurrentProcess(), out var guardianCreated, out _, out _, out _), "control guardian identity");
                if (!string.Equals(helper, expectedHelper, StringComparison.OrdinalIgnoreCase) || Hash(File.ReadAllBytes(helper)) != Text(value, "helperSha256") || value.GetProperty("creatorPid").GetUInt32() != creator || Hash(Encoding.UTF8.GetBytes(cwd.ToLowerInvariant())) != Text(value, "cwdSha256") || ArgumentHash(argv) != Text(value, "commandSha256")) throw new SupervisorFailure("prepared helper, creator, workspace or command changed");
                claimed = new FileStream(Path.Combine(directory, "claim.json"), FileMode.CreateNew, FileAccess.ReadWrite, FileShare.Read, 4096, FileOptions.WriteThrough);
                byte[] claimBytes = JsonSerializer.SerializeToUtf8Bytes(new { schemaVersion = 1, token, requestSha256 = requestHash }); claimed.Write(claimBytes); claimed.Flush(true);
                request = opened; claim = claimed;
                binding = new Dictionary<string, object?> {
                    ["schemaVersion"] = 1, ["token"] = token, ["requestSha256"] = requestHash,
                    ["scopeSha256"] = Text(value, "scopeSha256"), ["helperPath"] = helper, ["helperSha256"] = Text(value, "helperSha256"),
                    ["creatorPid"] = creator, ["creatorCreated"] = creatorCreated.Value.ToString(),
                    ["guardianPid"] = Environment.ProcessId, ["guardianCreated"] = guardianCreated.Value.ToString(),
                    ["cwdSha256"] = Text(value, "cwdSha256"), ["commandSha256"] = Text(value, "commandSha256"),
                    ["jobId"] = Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(32)),
                    ["publicKey"] = Convert.ToBase64String(signer.ExportSubjectPublicKeyInfo()), ["armedAt"] = DateTimeOffset.UtcNow.ToString("O")
                };
            }
            catch { opened?.Dispose(); claimed?.Dispose(); directoryHandle.Dispose(); signer.Dispose(); throw; }
        }

        public void Arm()
        {
            byte[] bytes = JsonSerializer.SerializeToUtf8Bytes(binding);
            Atomic("armed.json", bytes);
            armed = ReadLocked(Path.Combine(directory, "armed.json"));
            armedHash = Hash(bytes);
            if (Hash(ReadBytes(armed)) != armedHash) throw new SupervisorFailure("armed control record changed");
        }

        public string? AwaitAcknowledgement(KernelHandle owner)
        {
            var deadline = Stopwatch.StartNew();
            while (true)
            {
                if (Native.WaitForSingleObject(owner, 0) == 0) return "creator-exited";
                if (CancellationRequested()) return "cancelled";
                string ack = Path.Combine(directory, "ack.json");
                if (File.Exists(ack)) { CheckMessage(ack, true); return null; }
                if (deadline.ElapsedMilliseconds >= 15000) throw new SupervisorFailure("control acknowledgement timed out");
                Thread.Sleep(10);
            }
        }

        public bool CancellationRequested()
        {
            string file = Path.Combine(directory, "cancel.json");
            if (!File.Exists(file)) return false;
            CheckMessage(file); return true;
        }

        private void CheckMessage(string file, bool acknowledgement = false)
        {
            using var opened = ReadLocked(file);
            using var document = JsonDocument.Parse(ReadBytes(opened));
            var value = document.RootElement;
            if (!Exact(value, ["schemaVersion", "token", "requestSha256", "armedSha256", "deadlineUnixMs"]) || value.GetProperty("schemaVersion").GetInt32() != 1 || Text(value, "token") != token || Text(value, "requestSha256") != requestHash || Text(value, "armedSha256") != armedHash) throw new SupervisorFailure("control message binding changed");
            var deadline = value.GetProperty("deadlineUnixMs");
            if (acknowledgement ? !deadline.TryGetInt64(out long limit) || limit <= DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() : deadline.ValueKind != JsonValueKind.Null)
                throw new SupervisorFailure("control acknowledgement deadline expired or changed");
            if (acknowledgement) acknowledgedDeadline = deadline.GetInt64();
        }

        public void RequireDispatchAllowed(KernelHandle owner)
        {
            RequireOwnerAlive(owner);
            if (CancellationRequested() || acknowledgedDeadline <= DateTimeOffset.UtcNow.ToUnixTimeMilliseconds())
                throw new SupervisorFailure("owned launch cancelled or acknowledgement expired before dispatch");
        }

        // A short-lived, captured native publisher handles Windows' atomic
        // no-replace rename. It never opens/terminates a PID or creates a Job.
        // The stdin commit handshake lets the host enforce its deadline/Abort
        // immediately before ACK publication, and makes crash windows testable.
        public static int PublishMessage(string proposedDirectory, string proposedToken, string proposedBinding, string kind, string deadlineText)
        {
            if (!Hex(proposedToken) || !Hex(proposedBinding) || kind is not ("ack" or "cancel") || !long.TryParse(deadlineText, out long deadline) || kind == "cancel" && deadline != 0)
                throw new SupervisorFailure("invalid control publication");
            string directory = CheckedPath(proposedDirectory, true);
            if (Path.GetFileName(directory) != proposedToken) throw new SupervisorFailure("control publication directory changed");
            using var owner = OpenCreatingProcess();
            using var request = ReadLocked(Path.Combine(directory, "request.json"));
            using var armed = ReadLocked(Path.Combine(directory, "armed.json"));
            byte[] requestBytes = ReadBytes(request), armedBytes = ReadBytes(armed);
            using var requestDocument = JsonDocument.Parse(requestBytes);
            using var armedDocument = JsonDocument.Parse(armedBytes);
            var prepared = requestDocument.RootElement; var binding = armedDocument.RootElement;
            string helper = CheckedPath(Environment.ProcessPath!, false), requestHash = Hash(requestBytes);
            if (!Exact(prepared, requestFields) || Text(prepared, "token") != proposedToken || Text(prepared, "helperSha256") != Hash(File.ReadAllBytes(helper)) || !string.Equals(Text(prepared, "helperPath"), helper, StringComparison.OrdinalIgnoreCase) || Hash(armedBytes) != proposedBinding || Text(binding, "token") != proposedToken || Text(binding, "requestSha256") != requestHash)
                throw new SupervisorFailure("control publication ownership changed");
            void CheckDeadline()
            {
                if (kind == "ack" && (deadline <= DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() || deadline > DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + 15000))
                    throw new SupervisorFailure("control publication deadline expired");
                RequireOwnerAlive(owner);
            }
            CheckDeadline();
            byte[] bytes = JsonSerializer.SerializeToUtf8Bytes(new { schemaVersion = 1, token = proposedToken, requestSha256 = requestHash, armedSha256 = proposedBinding, deadlineUnixMs = kind == "ack" ? (long?)deadline : null });
            string temporary = Path.Combine(directory, "." + Guid.NewGuid().ToString("N") + ".tmp"), target = Path.Combine(directory, kind + ".json");
            try
            {
                using (var stream = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None, 4096, FileOptions.WriteThrough)) { stream.Write(bytes); stream.Flush(true); }
                Console.Out.WriteLine("{\"prepared\":true}"); Console.Out.Flush();
                var commit = Console.In.ReadLineAsync(); var wait = Stopwatch.StartNew();
                while (!commit.IsCompleted) { CheckDeadline(); if (wait.ElapsedMilliseconds >= 5000) throw new SupervisorFailure("control publication was not committed"); Thread.Sleep(5); }
                if (commit.GetAwaiter().GetResult() != "commit") throw new SupervisorFailure("control publication was not committed");
                CheckDeadline();
                if (Hash(ReadBytes(request)) != requestHash || Hash(ReadBytes(armed)) != proposedBinding) throw new SupervisorFailure("control publication evidence changed");
                if (!Native.MoveFileExW(temporary, target, 8))
                {
                    // Another publisher may have won. Accept only its complete,
                    // single-link, byte-identical cancellation; never overwrite.
                    using var existing = ReadLocked(target);
                    if (!ReadBytes(existing).SequenceEqual(bytes)) throw new SupervisorFailure("pending control publication changed");
                }
                return 0;
            }
            finally { if (File.Exists(temporary)) File.Delete(temporary); }
        }

        public void Complete(KernelHandle job, string reason, uint? exitCode)
        {
            if (completed || armedHash is null || armed is null) return;
            // No signature is emitted until the ACTUAL held Job says zero. An
            // absent guardian/Job name or missing PID is never substituted here.
            if (ActiveProcesses(job) != 0) throw new SupervisorFailure("terminal job accounting is not zero");
            if (Hash(ReadBytes(request)) != requestHash || Hash(ReadBytes(armed)) != armedHash) throw new SupervisorFailure("immutable control evidence changed");
            string payload = JsonSerializer.Serialize(new { schemaVersion = 1, token, requestSha256 = requestHash, armedSha256 = armedHash, jobId = binding["jobId"], activeProcesses = 0, reason, mainExitCode = exitCode, finishedAt = DateTimeOffset.UtcNow.ToString("O") });
            string signature = Convert.ToBase64String(signer.SignData(Encoding.UTF8.GetBytes(payload), HashAlgorithmName.SHA256, DSASignatureFormat.IeeeP1363FixedFieldConcatenation));
            Atomic("terminal.json", JsonSerializer.SerializeToUtf8Bytes(new { schemaVersion = 1, payload, signature }));
            completed = true;
        }

        private void Atomic(string name, byte[] bytes)
        {
            CheckedPath(directory, true);
            string temporary = Path.Combine(directory, "." + Guid.NewGuid().ToString("N") + ".tmp"), target = Path.Combine(directory, name);
            try
            {
                using (var stream = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None, 4096, FileOptions.WriteThrough)) { stream.Write(bytes); stream.Flush(true); }
                Require(Native.MoveFileExW(temporary, target, 8), "atomic control publication");
            }
            finally { if (File.Exists(temporary)) File.Delete(temporary); }
        }

        private static FileStream ReadLocked(string file)
        {
            CheckedPath(file, false);
            var stream = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.Read);
            try { _ = ReadBytes(stream); return stream; } catch { stream.Dispose(); throw; }
        }
        private static byte[] ReadBytes(FileStream stream)
        {
            Require(Native.GetFileInformationByHandle(stream.SafeFileHandle, out var information), "control file identity");
            if (information.Links != 1 || stream.Length < 1 || stream.Length > 16384) throw new SupervisorFailure("invalid control file");
            stream.Position = 0; byte[] bytes = new byte[stream.Length]; stream.ReadExactly(bytes); return bytes;
        }
        private static bool Exact(JsonElement value, string[] fields) => value.ValueKind == JsonValueKind.Object && value.EnumerateObject().Count() == fields.Length && fields.All(field => value.TryGetProperty(field, out _));
        private static string Text(JsonElement value, string key) => value.GetProperty(key).GetString() ?? throw new SupervisorFailure("invalid control text");
        private static bool Hex(string value) => value.Length == 64 && value.All(c => c is >= '0' and <= '9' or >= 'a' and <= 'f');
        private static string Hash(byte[] bytes) => Convert.ToHexStringLower(SHA256.HashData(bytes));
        private static string ArgumentHash(string[] values)
        {
            using var stream = new MemoryStream();
            foreach (string value in values) { byte[] bytes = Encoding.UTF8.GetBytes(value); stream.Write(BitConverter.GetBytes(bytes.Length)); stream.Write(bytes); }
            return Hash(stream.ToArray());
        }
        private static bool Contains(string root, string file) => file.Equals(root, StringComparison.OrdinalIgnoreCase) || file.StartsWith(root.TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase);
        private static string CheckedPath(string proposed, bool directory)
        {
            string full = Path.GetFullPath(proposed);
            if (!Path.IsPathFullyQualified(proposed) || full.StartsWith(@"\\") || proposed.Contains('~') || !string.Equals(proposed.TrimEnd(Path.DirectorySeparatorChar), full.TrimEnd(Path.DirectorySeparatorChar), StringComparison.OrdinalIgnoreCase)) throw new SupervisorFailure("control paths must be canonical local paths");
            string current = Path.GetPathRoot(full)!;
            foreach (string part in full[current.Length..].Split(Path.DirectorySeparatorChar, StringSplitOptions.RemoveEmptyEntries))
            {
                current = Path.Combine(current, part);
                if ((File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0) throw new SupervisorFailure("control paths cannot contain reparse points");
            }
            if (Directory.Exists(full) != directory) throw new SupervisorFailure("control path kind changed");
            return full.TrimEnd(Path.DirectorySeparatorChar);
        }
        public void Dispose() { armed?.Dispose(); claim.Dispose(); request.Dispose(); directoryHandle.Dispose(); signer.Dispose(); }
    }

    private sealed class StandardHandles : IDisposable
    {
        private readonly List<KernelHandle> handles = [];
        private IntPtr attributes;
        private IntPtr handleArray;
        private IntPtr jobArray;
        private bool initialized;
        public StartupInfoEx Startup;

        public StandardHandles(KernelHandle job)
        {
            try
            {
                var input = DuplicateStandard(-10, true);
                var output = DuplicateStandard(-11, false);
                var error = DuplicateStandard(-12, false);
                nuint size = 0;
                Native.InitializeProcThreadAttributeList(IntPtr.Zero, 2, 0, ref size);
                if (size == 0 || size > int.MaxValue) throw new SupervisorFailure("handle list sizing failed");
                attributes = Marshal.AllocHGlobal(checked((int)size));
                Require(Native.InitializeProcThreadAttributeList(attributes, 2, 0, ref size), "handle list initialization");
                initialized = true;
                handleArray = Marshal.AllocHGlobal(IntPtr.Size * 3);
                Marshal.Copy(new[] { input, output, error }, 0, handleArray, 3);
                Require(Native.UpdateProcThreadAttribute(attributes, 0, (nuint)0x00020002, handleArray,
                    (nuint)(IntPtr.Size * 3), IntPtr.Zero, IntPtr.Zero), "standard handle inheritance");
                // Windows 10+ assigns the job atomically inside CreateProcess.
                // This also covers a force-kill between creation and verification;
                // there is never an unowned suspended child left behind.
                jobArray = Marshal.AllocHGlobal(IntPtr.Size);
                Marshal.WriteIntPtr(jobArray, job.DangerousGetHandle());
                Require(Native.UpdateProcThreadAttribute(attributes, 0, (nuint)0x0002000d, jobArray,
                    (nuint)IntPtr.Size, IntPtr.Zero, IntPtr.Zero), "atomic job assignment");
                Startup = new StartupInfoEx
                {
                    Startup = new StartupInfo
                    {
                        Size = (uint)Marshal.SizeOf<StartupInfoEx>(),
                        Flags = UseStdHandles,
                        Input = input, Output = output, Error = error
                    },
                    Attributes = attributes
                };
            }
            catch { Dispose(); throw; }
        }

        private IntPtr DuplicateStandard(int id, bool input)
        {
            IntPtr source = Native.GetStdHandle(id);
            using var fallback = source == IntPtr.Zero || source == new IntPtr(-1)
                ? Native.CreateFileW("NUL", input ? 0x80000000u : 0x40000000u, 3, IntPtr.Zero, 3, 0, IntPtr.Zero)
                : null;
            if (fallback is not null) { Require(!fallback.IsInvalid, "null stream opening"); source = fallback.DangerousGetHandle(); }
            IntPtr current = Native.GetCurrentProcess();
            Require(Native.DuplicateHandle(current, source, current, out IntPtr copy, 0, true, 2), "standard handle duplication");
            handles.Add(new KernelHandle(copy));
            return copy;
        }

        public void Dispose()
        {
            if (initialized) { Native.DeleteProcThreadAttributeList(attributes); initialized = false; }
            if (attributes != IntPtr.Zero) { Marshal.FreeHGlobal(attributes); attributes = IntPtr.Zero; }
            if (handleArray != IntPtr.Zero) { Marshal.FreeHGlobal(handleArray); handleArray = IntPtr.Zero; }
            if (jobArray != IntPtr.Zero) { Marshal.FreeHGlobal(jobArray); jobArray = IntPtr.Zero; }
            foreach (var handle in handles) handle.Dispose();
            handles.Clear();
        }
    }

    private sealed class KernelHandle : SafeHandleZeroOrMinusOneIsInvalid
    {
        public KernelHandle() : base(true) { }
        public KernelHandle(IntPtr value) : base(true) { SetHandle(value); }
        protected override bool ReleaseHandle() => Native.CloseHandle(handle);
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessInformation { public IntPtr Process, Thread; public uint ProcessId, ThreadId; }
    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessBasicInformation
    {
        public int ExitStatus;
        public IntPtr Peb;
        public nuint Affinity;
        public int BasePriority;
        public nuint ProcessId, ParentProcessId;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct NativeTimestamp
    {
        public uint Low, High;
        public readonly ulong Value => ((ulong)High << 32) | Low;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct FileInformation
    {
        public uint Attributes;
        public NativeTimestamp Creation, Access, Write;
        public uint VolumeSerial, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct StartupInfo
    {
        public uint Size;
        public IntPtr Reserved, Desktop, Title;
        public uint X, Y, XSize, YSize, XCountChars, YCountChars, FillAttribute, Flags;
        public ushort ShowWindow, ReservedSize;
        public IntPtr ReservedBytes, Input, Output, Error;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct StartupInfoEx { public StartupInfo Startup; public IntPtr Attributes; }
    [StructLayout(LayoutKind.Sequential)]
    private struct BasicLimitInformation
    {
        public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
        public uint LimitFlags;
        public nuint MinimumWorkingSetSize, MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public nuint Affinity;
        public uint PriorityClass, SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct IoCounters { public ulong ReadOperations, WriteOperations, OtherOperations, ReadBytes, WriteBytes, OtherBytes; }
    [StructLayout(LayoutKind.Sequential)]
    private struct ExtendedLimitInformation
    {
        public BasicLimitInformation Basic;
        public IoCounters Io;
        public nuint ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct BasicAccountingInformation
    {
        public long TotalUserTime, TotalKernelTime, ThisPeriodUserTime, ThisPeriodKernelTime;
        public uint TotalPageFaults, TotalProcesses, ActiveProcesses, TotalTerminatedProcesses;
    }

    private static class Native
    {
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern KernelHandle CreateJobObjectW(IntPtr attributes, string? name);
        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool SetInformationJobObject(KernelHandle job, int type, ref ExtendedLimitInformation information, uint size);
        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool QueryInformationJobObject(KernelHandle job, int type, out BasicAccountingInformation information, uint size, IntPtr returned);
        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool IsProcessInJob(KernelHandle process, KernelHandle job, [MarshalAs(UnmanagedType.Bool)] out bool inJob);
        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool TerminateJobObject(KernelHandle job, uint exitCode);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool CreateProcessW(string application, StringBuilder command, IntPtr processAttributes, IntPtr threadAttributes,
            [MarshalAs(UnmanagedType.Bool)] bool inherit, uint flags, IntPtr environment, string? directory, ref StartupInfoEx startup, out ProcessInformation process);
        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool TerminateProcess(KernelHandle process, uint code);
        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern uint ResumeThread(KernelHandle thread);
        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern uint WaitForSingleObject(KernelHandle handle, uint milliseconds);
        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool GetExitCodeProcess(KernelHandle process, out uint code);
        [DllImport("kernel32.dll")]
        public static extern IntPtr GetCurrentProcess();
        [DllImport("ntdll.dll")]
        public static extern int NtQueryInformationProcess(IntPtr process, uint type, out ProcessBasicInformation information, uint size, out uint returned);
        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern KernelHandle OpenProcess(uint access, [MarshalAs(UnmanagedType.Bool)] bool inherit, uint processId);
        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern uint GetProcessId(KernelHandle process);
        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool GetFileInformationByHandle(SafeFileHandle file, out FileInformation information);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool MoveFileExW(string existing, string destination, uint flags);
        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool GetProcessTimes(IntPtr process, out NativeTimestamp creation, out NativeTimestamp exit, out NativeTimestamp kernel, out NativeTimestamp user);
        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern uint WaitForMultipleObjects(uint count, IntPtr[] handles, [MarshalAs(UnmanagedType.Bool)] bool all, uint milliseconds);
        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern IntPtr GetStdHandle(int id);
        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool DuplicateHandle(IntPtr sourceProcess, IntPtr source, IntPtr targetProcess, out IntPtr target, uint access,
            [MarshalAs(UnmanagedType.Bool)] bool inherit, uint options);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern KernelHandle CreateFileW(string name, uint access, uint share, IntPtr attributes, uint creation, uint flags, IntPtr template);
        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool InitializeProcThreadAttributeList(IntPtr list, uint count, uint flags, ref nuint size);
        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, nuint attribute, IntPtr value, nuint size, IntPtr previous, IntPtr returned);
        [DllImport("kernel32.dll")]
        public static extern void DeleteProcThreadAttributeList(IntPtr list);
        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool CloseHandle(IntPtr handle);
    }
}
