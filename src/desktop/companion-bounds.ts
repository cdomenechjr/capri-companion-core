type Bounds={x:number;y:number;width:number;height:number};
/** Work areas may start left of, above, or to the right of the primary display. */
export function companionBounds(area:Bounds,scale:number,previous?:Bounds):Bounds{
 const margin=12;const fit=Math.min(scale,(area.width-margin*2)/330,(area.height-margin*2)/510);
 const width=Math.max(1,Math.round(330*fit));const height=Math.max(1,Math.round(510*fit));
 return {width,height,x:Math.round(Math.max(area.x+margin,Math.min(previous?.x??area.x+area.width-width-20,area.x+area.width-width-margin))),y:Math.round(Math.max(area.y+margin,Math.min(previous?.y??area.y+24,area.y+area.height-height-margin)))};
}
