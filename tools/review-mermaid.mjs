import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import puppeteer from 'puppeteer';
import {hashOf} from './render-diagrams.mjs';
const root=path.resolve(import.meta.dirname,'..');
fs.mkdirSync('/tmp/mermaid-review',{recursive:true});
const entries=new Map();
function walk(dir){for(const d of fs.readdirSync(path.join(root,dir),{withFileTypes:true})){const f=path.join(dir,d.name);if(d.isDirectory())walk(f);else if(f.endsWith('.md')){const md=fs.readFileSync(path.join(root,f),'utf8');for(const m of md.matchAll(/```mermaid\n([\s\S]*?)```/g)){const hash=crypto.createHash('sha1').update(m[1]).digest('hex').slice(0,16);const location={file:f,line:md.slice(0,m.index).split('\n').length,section:[...md.slice(0,m.index).matchAll(/^#{1,6} (.+)$/gm)].at(-1)?.[1]};if(entries.has(hash))entries.get(hash).locations.push(location);else entries.set(hash,{hash,source:m[1],locations:[location]});}}}}
for(const dir of ['LLD/CoreConcepts','LLD/questions','LLD/SystemDesign','DSA'])walk(dir);
const all=[...entries.values()];all.forEach((e,i)=>{e.index=i;const file=path.join(root,'site/assets/diagrams',hashOf(e.source)+'.svg');const svg=fs.existsSync(file)?fs.readFileSync(file,'utf8'):'<svg><text y=20>MISSING CACHE</text></svg>';e.svg=svg;e.viewBox=svg.match(/viewBox="([^"]+)"/)?.[1];});
fs.writeFileSync('/tmp/mermaid-review/index.json',JSON.stringify(all.map(({svg,...e})=>e),null,2));
const browser=await puppeteer.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',args:['--no-sandbox']});const page=await browser.newPage();await page.setViewport({width:1800,height:1500,deviceScaleFactor:1});
for(let n=0;n<all.length;n+=20){const rows=all.slice(n,n+20);await page.setContent(`<style>body{margin:0;background:#d1d9e2;font:14px sans-serif}.grid{display:grid;grid-template-columns:repeat(4,450px)}.tile{height:300px;box-sizing:border-box;border:2px solid #aaa;background:white;padding:5px}.label{height:30px;font-size:12px;overflow:hidden}.pic{height:255px;display:flex;align-items:center;justify-content:center}.pic svg{max-width:100%!important;max-height:255px!important;width:auto!important;height:auto!important}</style><div class="grid">${rows.map(e=>`<div class="tile"><div class="label">${e.index}: ${e.locations[0].file} L${e.locations[0].line}</div><div class="pic">${e.svg}</div></div>`).join('')}</div>`);await page.screenshot({path:`/tmp/mermaid-review/new-sheet-${Math.floor(n/20)}.png`});}for(const index of [2,217,310,450,544]){const e=all[index];await page.setViewport({width:1400,height:1200,deviceScaleFactor:1});await page.setContent('<style>body{background:white;margin:20px}svg{max-width:1300px!important;width:100%!important;height:auto!important}</style>'+e.svg);await page.screenshot({path:`/tmp/mermaid-review/detail-${index}.png`,fullPage:true});}await browser.close();console.log(`Generated ${Math.ceil(all.length/20)} sheets for ${all.length} unique diagrams`);
// Contact sheets are triage artifacts; use the original SVG at native size to
// confirm suspected label collisions before reporting a rendering defect.
