export function wakeKeywords(phrase:string,dictionary:Map<string,string>){
 const words=phrase.toUpperCase().trim().split(/\s+/);if(words.length>6||words.some(word=>!dictionary.has(word)))throw Error('Wake phrase contains an unknown word. Choose common English words.');
 let pronunciations=[''];for(const word of words){const variants=word==='CAPRI'?[dictionary.get(word)!,'K AH0 P R IY1','K AE0 P R IY1','K AA0 P R IY1']:[dictionary.get(word)!];pronunciations=pronunciations.flatMap(prefix=>variants.map(variant=>(prefix+' '+variant).trim()));}
 return [...new Set(pronunciations)].map(tokens=>tokens+' @CAPRI_WAKE').join('\n')+'\n';
}
