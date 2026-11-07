export type Rect={x:number;y:number;width:number;height:number};
export type CompanionMode='follow'|'call'|'free';
export type CompanionPreferences={mode:CompanionMode;sitOnWindows:boolean;gameApps:string[]};
export const defaultCompanionPreferences:CompanionPreferences={mode:'follow',sitOnWindows:true,gameApps:[]};
export type DesktopWindow={id:number;rect:Rect;path:string;eligible:boolean};
export type Presence={foreground?:DesktopWindow;windows:DesktopWindow[];idleMs:number;fullscreen:boolean;exclusive:boolean;locked:boolean;error?:string};
export type CompanionState={type:'companion';preferred:CompanionMode;mode:CompanionMode;following:boolean;gameDocked:boolean;hidden:boolean;seated?:boolean;lean:number;idleMs:number;clip?:'dangle'|'grin'|'wake';reason?:string};
export function isGame(p:Presence,rules:string[]){const executable=p.foreground?.path.toLowerCase()||'';return p.fullscreen||p.exclusive||/[/\\](?:(?:terraria|robloxplayerbeta)(?:\.exe)?|tmodloader)(?:[/\\.]|$)/i.test(executable)||rules.some(rule=>rule.toLowerCase()===executable);}
export class GameDocking{
 private candidate?:boolean;private since=0;docked=false;
 update(p:Presence,rules:string[],now:number){if(p.error||p.locked){this.candidate=undefined;return this.docked=true;}const game=isGame(p,rules);if(game!==this.candidate){this.candidate=game;this.since=now;}if(now-this.since>=(game?500:2000))this.docked=game;return this.docked;}
}
export function clampRect(rect:Rect,area:Rect):Rect{const width=Math.min(Math.round(rect.width),Math.floor(area.width)),height=Math.min(Math.round(rect.height),Math.floor(area.height));return {...rect,width,height,x:Math.round(Math.max(area.x,Math.min(rect.x,area.x+area.width-width))),y:Math.round(Math.max(area.y,Math.min(rect.y,area.y+area.height-height)))};}
export function followPosition(cursor:{x:number;y:number},area:Rect,previous:Rect,size:number,lean:number){const target=clampRect({...previous,x:cursor.x-(size*.267-12),y:cursor.y-(size*.73+12)},area);const x=previous.x+Math.round((target.x-previous.x)*.25),y=previous.y+Math.round((target.y-previous.y)*.25);return {bounds:clampRect({...previous,x,y},area),lean:lean*.8+Math.max(-8,Math.min(8,(x-previous.x)*.4))*.2};}
export function chooseSeat(windows:DesktopWindow[],body:Rect,area:Rect){const feet={x:body.x+body.width*.5,y:body.y+body.height*.86};const candidates=windows.filter((w,index)=>w.eligible&&w.rect.y>=feet.y-20&&feet.x>=w.rect.x&&feet.x<=w.rect.x+w.rect.width&&!windows.slice(0,index).some(above=>feet.x>=above.rect.x&&feet.x<=above.rect.x+above.rect.width&&w.rect.y>=above.rect.y&&w.rect.y<above.rect.y+above.rect.height)).sort((a,b)=>a.rect.y-b.rect.y);const w=candidates[0];return w?{id:w.id,y:w.rect.y-body.height*.86,x:body.x}:{id:0,y:area.y+area.height-body.height,x:body.x};}
