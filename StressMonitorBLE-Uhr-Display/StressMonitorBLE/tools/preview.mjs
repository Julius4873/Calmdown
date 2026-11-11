// Layout-Vorschau mit den eingebauten Seeed-Schriften, keine Hardwareaufnahme.
import {readFileSync,writeFileSync} from 'node:fs';
import {deflateSync} from 'node:zlib';
const base='.arduino-local/user/libraries/Seeed_GFX/Fonts/';
function clean(s){return s.replace(/\/\*[\s\S]*?\*\//g,'').replace(/\/\/[^\n]*/g,'').replace(/#ifdef[^\n]*\n([\s\S]*?)#else[\s\S]*?#endif/g,'$1');}
function values(s){return [...s.matchAll(/0x[0-9a-f]+|\b\d+\b/gi)].map(m=>Number(m[0]));}
const fonts={};
for(const [id,name,tag,height] of [[2,'Font16.c','16',16],[4,'Font32rle.c','32',26],[6,'Font64rle.c','64',48]]){
 const src=clean(readFileSync(base+name,'utf8'));
 const widths=values(src.match(new RegExp('widtbl_f'+tag+'\\[96\\][^=]*=\\s*\\{([^}]+)'))[1]);
 const glyphs={};
 for(const m of src.matchAll(new RegExp('chr_f'+tag+'_([0-9A-Fa-f]{2})\\[[^\\]]*\\][^=]*=\\s*\\{([^}]+)','g'))) glyphs[parseInt(m[1],16)]=values(m[2]);
 fonts[id]={widths,glyphs,height};
}
const classic=values(clean(readFileSync(base+'glcdfont.c','utf8')).match(/font\[\][^{]*\{([^}]+)/)[1]);
const W=768,H=256,rgba=Buffer.alloc(W*H*4);
function rgb(c){return [Math.round((c>>11)*255/31),Math.round(((c>>5)&63)*255/63),Math.round((c&31)*255/31)];}
let ox=8,oy=8;
function pixel(x,y,c){x+=ox;y+=oy;if(x<0||x>=W||y<0||y>=H)return;const i=(y*W+x)*4;rgba.set([...rgb(c),255],i);}
function roundRect(x,y,w,h,r,c){for(let yy=0;yy<h;yy++)for(let xx=0;xx<w;xx++){const dx=Math.max(r-xx-.5,xx-w+r+.5,0),dy=Math.max(r-yy-.5,yy-h+r+.5,0);if(dx*dx+dy*dy<=r*r)pixel(x+xx,y+yy,c);}}
function circle(r,c,fill=false){for(let y=0;y<240;y++)for(let x=0;x<240;x++){const d=Math.hypot(x-120,y-120);if(fill?d<=r:Math.abs(d-r)<.6)pixel(x,y,c);}}
function width(text,id){return [...text].reduce((n,c)=>n+(id===1?6:fonts[id].widths[c.charCodeAt(0)-32]),0);}
function text(s,x,y,id,c){
 for(const ch of s){const n=ch.charCodeAt(0),w=id===1?6:fonts[id].widths[n-32];
  if(id===1){for(let xx=0;xx<5;xx++)for(let yy=0;yy<8;yy++)if(classic[n*5+xx]&(1<<yy))pixel(x+xx,y+yy,c);}
  else {const f=fonts[id],g=f.glyphs[n];if(!g)throw Error('Glyph fehlt: '+id+' '+ch);
   if(id===2){const bytes=g.length/f.height;for(let yy=0;yy<f.height;yy++)for(let xx=0;xx<w;xx++)if(g[yy*bytes+(xx>>3)]&(128>>(xx%8)))pixel(x+xx,y+yy,c);}
   else {let at=0;for(const b of g){const len=(b&127)+1;for(let k=0;k<len;k++,at++)if(b&128)pixel(x+at%w,y+Math.floor(at/w),c);}}
  } x+=w;
 }
}
const theme={bg:0x0863,card:0x10E5,border:0x21A8,white:0xEF9E,muted:0x9D16,teal:0x4F38,coral:0xFD51};
const center=(s,y,id,c)=>text(s,Math.floor(120-width(s,id)/2),y,id,c);
function card(x,label,value,accent,warn){const surface=warn?0x4000:theme.card;roundRect(x,91,90,78,12,surface);roundRect(x+12,103,3,10,1,accent);text(label,x+22,103,1,theme.muted);text(value,x+45-Math.floor(width(value,4)/2),119,4,theme.white);text('/ min',x+30,151,1,theme.muted);}
for(let view=0;view<3;view++){
 ox=8+view*256;circle(119,view===1?0xC800:theme.bg,true);circle(117,view===1?theme.white:theme.border);
 if(view<2){center('13:45',24,6,theme.white);center('06.11.2026',76,1,theme.muted);card(25,'PULS',view?'112':'72',theme.coral,view);card(125,'ATMUNG',view?'24.0':'12.0',theme.teal,view);center(view?'WERTE ERHOEHT':'Messung aktiv',181,2,view?theme.white:theme.muted);center('BLE verbunden',207,1,theme.teal);}
 else {center('13:45',23,2,theme.muted);center('ATEMHILFE',49,1,theme.teal);center('Einatmen',70,4,theme.white);center('3',103,6,theme.teal);center('Sanft und angenehm',159,2,theme.muted);center('Puls 96  |  Atmung 18.0',183,1,theme.muted);roundRect(73,204,94,5,2,theme.border);roundRect(73,204,24,5,2,theme.teal);}
}
function crc(b){let c=0xffffffff;for(const n of b){c^=n;for(let j=0;j<8;j++)c=c&1?0xedb88320^(c>>>1):c>>>1;}return(c^0xffffffff)>>>0;}
function chunk(name,data){const type=Buffer.from(name),out=Buffer.alloc(data.length+12);out.writeUInt32BE(data.length);type.copy(out,4);data.copy(out,8);out.writeUInt32BE(crc(Buffer.concat([type,data])),out.length-4);return out;}
const header=Buffer.alloc(13);header.writeUInt32BE(W);header.writeUInt32BE(H,4);header[8]=8;header[9]=6;
const rows=Buffer.alloc((W*4+1)*H);for(let y=0;y<H;y++)rgba.copy(rows,y*(W*4+1)+1,y*W*4,(y+1)*W*4);
writeFileSync('StressMonitorBLE/Anzeige-Vorschau.png',Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(rows)),chunk('IEND',Buffer.alloc(0))]));
