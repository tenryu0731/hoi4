import { chromium, devices } from '@playwright/test';
const browser = await chromium.launch({ executablePath:'/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args:['--no-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-dev-shm-usage']});
const ctx = await browser.newContext({...devices['Pixel 7'],deviceScaleFactor:2,viewport:{width:412,height:869},isMobile:true,hasTouch:true});
const page = await ctx.newPage();
await page.goto('http://127.0.0.1:4188/?static=1');
await page.waitForFunction(()=>window.__gameReady===true,null,{timeout:180000});
const centre = await page.evaluate(()=>{const g=window.__game;const c=g.index.get(g.state.countries[g.state.meta.playerCountry].capital);return{x:c.centerX,y:c.centerY};});
const rows=[];
for (const z of [0.045,0.057,0.08,0.10,0.13,0.17,0.24,0.30,0.45,0.9]) {
  const r = await page.evaluate(({z,cx,cy})=>{
    const g=window.__game;
    g.renderer.camera.zoom=z; g.renderer.camera.centerOn(cx,cy);
    g.renderer.camera.zoom=z; g.renderer.camera.centerOn(cx,cy);
    for(let i=0;i<12;i++) g.tickFrame(16.667);
    const L=g.renderer.labels;
    const vis=a=>a.filter(e=>e.text.visible).length;
    const de = L.countryLabels.find(e=>e.text.text==='ドイツ');
    return { zoom:+g.renderer.camera.zoom.toFixed(3), country:vis(L.countryLabels), prov:vis(L.provinceLabels), city:vis(L.cityLabels),
      ger: de? {w:Math.round(de.text.width), shapeW:Math.round(de.shapeW*z), shapeH:Math.round(de.shapeH*z), vis:de.text.visible}:null };
  },{z,cx:centre.x,cy:centre.y});
  rows.push(r);
}
console.log(JSON.stringify(rows));
await browser.close();
