import { chromium, devices } from '@playwright/test';
const OUT='/tmp/shots', SHOT={timeout:180000};
const browser = await chromium.launch({ executablePath:'/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args:['--no-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-dev-shm-usage']});
const ctx = await browser.newContext({...devices['Pixel 7'],deviceScaleFactor:2,viewport:{width:412,height:869},isMobile:true,hasTouch:true});
const page = await ctx.newPage();
await page.goto('http://127.0.0.1:4188/?static=1');
await page.waitForFunction(()=>window.__gameReady===true,null,{timeout:180000});
const centre = await page.evaluate(()=>{const g=window.__game;const c=g.index.get(g.state.countries[g.state.meta.playerCountry].capital);return{x:c.centerX,y:c.centerY};});
const r = await page.evaluate(()=>{
  const g=window.__game, me=g.state.meta.playerCountry;
  const pol=g.state.countries.findIndex(c=>c.tag==='POL');
  g.issue({t:'declareWar',country:me,target:pol});
  g.stepHours(24*40);
  return {wars:g.state.wars.length, y:g.state.clock.year, m:g.state.clock.month, d:g.state.clock.day};
});
console.log('WAR', JSON.stringify(r));
await page.evaluate(({x,y})=>{const g=window.__game;
  for(const k of [0,1]){g.renderer.camera.zoom=0.20;g.renderer.camera.centerOn(x+250,y);}
  for(let i=0;i<40;i++) g.tickFrame(16.667);},centre);
await page.waitForTimeout(600);
await page.screenshot({path:`${OUT}/12-war-front.png`,...SHOT});
await page.evaluate(()=>{window.__game.state.outcome={status:'defeat',reason:'capitulated'};
  for(let i=0;i<20;i++) window.__game.tickFrame(16.667);});
await page.waitForTimeout(1200);
await page.screenshot({path:`${OUT}/13-outcome.png`,...SHOT});
await browser.close(); console.log('done');
