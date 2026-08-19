import { chromium, devices } from '@playwright/test';
const b = await chromium.launch({ executablePath:'/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args:['--no-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-dev-shm-usage']});
const c = await b.newContext({...devices['Pixel 7'],deviceScaleFactor:2,viewport:{width:412,height:869},isMobile:true,hasTouch:true});
const p = await c.newPage();
await p.goto('http://127.0.0.1:4188/?static=1');
await p.waitForFunction(()=>window.__gameReady===true,null,{timeout:180000});
// sample the actual pixels of a nav icon by drawing it to a canvas
const r = await p.evaluate(async ()=>{
  const img = document.querySelector('.hud-nav-btn[data-panel="army"] .hud-nav-icon');
  const cv = document.createElement('canvas'); cv.width=40; cv.height=40;
  const cx = cv.getContext('2d');
  cx.drawImage(img,0,0,40,40);
  const d = cx.getImageData(0,0,40,40).data;
  let dark=0, lit=0, opaque=0;
  const samples=[];
  for(let i=0;i<d.length;i+=4){ if(d[i+3]>40){opaque++; const L=(d[i]+d[i+1]+d[i+2])/3; if(L<60)dark++; else lit++; if(samples.length<4)samples.push([d[i],d[i+1],d[i+2],d[i+3]]);} }
  const cs = getComputedStyle(img.parentElement);
  return { opaquePx:opaque, darkPx:dark, litPx:lit, samples,
           parentColor:cs.color, navBg:getComputedStyle(document.querySelector('.hud-nav')).backgroundColor };
});
console.log(JSON.stringify(r));
await b.close();
