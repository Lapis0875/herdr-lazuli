import {test} from 'node:test'; import assert from 'node:assert/strict'; import {readFile} from 'node:fs/promises';
const rgb=s=>{assert.match(s,/^#[0-9a-fA-F]{6}$/); return [1,3,5].map(i=>parseInt(s.slice(i,i+2),16)/255).map(v=>v<=0.04045?v/12.92:((v+0.055)/1.055)**2.4);};
const lum=s=>rgb(s).reduce((a,v,i)=>a+v*[0.2126,0.7152,0.0722][i],0); const contrast=(a,b)=>{const x=lum(a),y=lum(b);return (Math.max(x,y)+0.05)/(Math.min(x,y)+0.05);};
for(const mode of ['light','dark']) test(`${mode} theme colors and text contrast`,async()=>{
 const theme=JSON.parse(await readFile(new URL(`../themes/lazuli-${mode}.json`,import.meta.url),'utf8')); assert.equal(theme.ansi.length,16);
 for(const c of [theme.background,theme.foreground,theme.selection,...theme.ansi,...Object.values(theme.colors??{})]) rgb(c);
 if(theme.cursor!==undefined) rgb(theme.cursor);
 const c={...theme.colors,background:theme.background,foreground:theme.foreground};
 for(const text of ['foreground','muted','dim','accent','working','blocked','done','idle']) for(const bg of ['background','canvas','chrome','surface','raised','popover','hover','selected']) assert.ok(contrast(c[text],c[bg])>=4.5,`${text}/${bg}`);
 for(const bg of ['background','canvas','chrome','surface','raised','popover','hover','selected']) assert.ok(contrast(theme.ansi[3],c[bg])>=4.5,`secondary/${bg}`);
 for(const [fg,bg] of [['accent_foreground','accent'],['solid_foreground','solid']]) assert.ok(contrast(c[fg],c[bg])>=4.5,`${fg}/${bg}`);
});
