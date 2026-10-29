/* npm install --prefix <tools-folder> @resvg/resvg-js
 * LUNERA_RESVG_PATH=<tools-folder>/node_modules/@resvg/resvg-js node scripts/generate-brand.cjs */
'use strict';
const fs=require('node:fs'),path=require('node:path');
const {Resvg}=require(process.env.LUNERA_RESVG_PATH||'@resvg/resvg-js');
const root=path.resolve(__dirname,'..'),brand=path.join(root,'assets/branding');
const svg=fs.readFileSync(path.join(brand,'lunera-moon.svg'),'utf8');
function png(size,foreground=false){return new Resvg(foreground?svg.replace('viewBox="-2 -2 28 28"','viewBox="-6 -6 36 36"'):svg,{fitTo:{mode:'width',value:size}}).render().asPng();}
function write(file,data){fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,data);}
for(const size of [16,24,32,48,64,128,192,256,512,1024])write(path.join(brand,`lunera-moon-${size}.png`),png(size));
for(const name of ['logo.png','logo2.png'])write(path.join(root,'assets',name),png(512));
for(const size of [192,512])write(path.join(root,`icon-${size}.png`),png(size));
const sizes=[16,24,32,48,64,128,256],frames=sizes.map(s=>png(s));
const header=Buffer.alloc(6+16*sizes.length);header.writeUInt16LE(1,2);header.writeUInt16LE(sizes.length,4);
let offset=header.length;
frames.forEach((frame,i)=>{const p=6+16*i,s=sizes[i];header[p]=s===256?0:s;header[p+1]=s===256?0:s;header.writeUInt16LE(1,p+4);header.writeUInt16LE(32,p+6);header.writeUInt32LE(frame.length,p+8);header.writeUInt32LE(offset,p+12);offset+=frame.length;});
write(path.join(brand,'lunera.ico'),Buffer.concat([header,...frames]));
const res=path.join(root,'Lunera Mobile/app/src/main/res');
for(const [density,legacy,foreground] of [['mdpi',48,108],['hdpi',72,162],['xhdpi',96,216],['xxhdpi',144,324],['xxxhdpi',192,432]]){
 write(path.join(res,`mipmap-${density}/ic_launcher.png`),png(legacy));
 write(path.join(res,`mipmap-${density}/ic_launcher_foreground.png`),png(foreground,true));
}
const rendered=new Resvg(svg,{fitTo:{mode:'width',value:512}}).render();
const pixels=rendered.pixels;let transparent=0,visible=0;
for(let i=3;i<pixels.length;i+=4){if(pixels[i]===0)transparent++;else visible++;}
if(!transparent||!visible||pixels[3]!==0)throw Error('The brand must have a transparent background and visible artwork');
console.log(JSON.stringify({png:'RGBA',transparentPixels:transparent,visiblePixels:visible,icoSizes:sizes,androidDensities:5}));
