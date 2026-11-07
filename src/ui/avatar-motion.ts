import {State} from '../shared';
export class AvatarMotion {
 private state:State='idle';private since=0;private voiced=-Infinity;private accent=-Infinity;private beat=0;
 update(state:State,level:number,now:number){
  if(state!==this.state){this.state=state;this.since=now;this.voiced=-Infinity;this.accent=-Infinity;this.beat=0;}
  const energy=Number.isFinite(level)?Math.max(0,Math.min(1,level)):0;
  if(state==='speaking'){
   if(energy>.04)this.voiced=now;
   if(energy>.4&&now-this.accent>1050){this.accent=now;this.beat++;}
  }
  const talking=state==='speaking'&&now-this.voiced<140;
  const emphasis=talking&&this.beat>0&&now-this.accent<650;
  const celebrating=state==='success'&&now-this.since<1500;
  return {talking,emphasis,celebrating,beat:this.beat,side:this.beat%2?1:-1};
 }
}
