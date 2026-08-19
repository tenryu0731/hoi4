import { chromium, devices } from '@playwright/test';
const b = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--no-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-dev-shm-usage'],
});
const ctx = await b.newContext({ ...devices['Pixel 7'], deviceScaleFactor: 2, viewport:{width:412,height:869}, isMobile:true, hasTouch:true });
const p = await ctx.newPage();
const errs=[]; p.on('pageerror',e=>errs.push(String(e))); p.on('console',m=>{if(m.type()==='error')errs.push(m.text());});
await p.goto('http://127.0.0.1:4180/?static=1');
await p.waitForFunction(()=>window.__gameReady===true,null,{timeout:60000});
await p.waitForTimeout(800);
const out = process.argv[2] || '/tmp/ui';
await p.screenshot({ path: `${out}-map.png` });
for (const panel of ['production','construction','army','diplomacy']) {
  await p.locator(`.hud-nav-btn[data-panel="${panel}"]`).click();
  await p.waitForTimeout(350);
  await p.screenshot({ path: `${out}-${panel}.png` });
}
console.log('errors:', errs.length ? errs.slice(0,5) : 'none');
await b.close();
