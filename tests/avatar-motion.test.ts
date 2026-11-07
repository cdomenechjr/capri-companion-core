import test from 'node:test';
import assert from 'node:assert/strict';
import {AvatarMotion} from '../src/ui/avatar-motion';
test('listening never animates talking, speech holds across tiny gaps and stops at silence or Stop',()=>{
 const motion=new AvatarMotion();
 assert.equal(motion.update('listening',1,0).talking,false);
 assert.equal(motion.update('speaking',0,10).talking,false);
 assert.equal(motion.update('speaking',.2,30).talking,true);
 assert.equal(motion.update('speaking',0,100).talking,true);
 assert.equal(motion.update('speaking',0,200).talking,false);
 assert.equal(motion.update('speaking',.8,230).emphasis,true);
 assert.equal(motion.update('idle',.8,240).talking,false);
 assert.equal(motion.update('listening',.8,250).emphasis,false);
});
test('success is a short reaction and invalid audio levels cannot trigger speech gestures',()=>{
 const motion=new AvatarMotion();
 assert.equal(motion.update('success',0,0).celebrating,true);
 assert.equal(motion.update('success',0,2000).celebrating,false);
 assert.equal(motion.update('speaking',NaN,2100).talking,false);
 assert.equal(motion.update('speaking',Infinity,2200).talking,false);
});
