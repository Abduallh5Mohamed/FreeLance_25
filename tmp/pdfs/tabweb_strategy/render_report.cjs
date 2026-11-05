const { chromium } = require('D:/EmanSchools/node_modules/playwright-core');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
(async()=>{
  const root=path.resolve(__dirname,'../../..');
  const browser=await chromium.launch({executablePath:'C:/Users/BaraaWael/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe',headless:true,args:['--disable-background-networking','--disable-component-update','--no-first-run']});
  try{
    const page=await browser.newPage({viewport:{width:1000,height:1300},deviceScaleFactor:1});
    await page.goto(pathToFileURL(path.join(__dirname,'report.html')).href,{waitUntil:'load'});
    await page.evaluate(()=>document.fonts.ready);
    await page.emulateMedia({media:'print'});
    const layout=await page.evaluate(()=>Array.from(document.querySelectorAll('.page')).map((s,i)=>{
      const rect=s.getBoundingClientRect(),body=s.querySelector('.body').getBoundingClientRect(),footer=s.querySelector('.footer').getBoundingClientRect();
      const out=Array.from(s.querySelectorAll('p,td,th,h1,h3,.reference,.card')).filter(x=>{const r=x.getBoundingClientRect();return r.right>rect.right-30||r.left<rect.left+30}).map(x=>x.textContent.slice(0,80));
      return {page:i+1,title:s.querySelector('h1').textContent,bodyBottom:body.bottom-rect.top,footerTop:footer.top-rect.top,overflow:Math.max(0,body.bottom-footer.top+10),horizontal:out};
    }));
    fs.writeFileSync(path.join(__dirname,'layout-check.json'),JSON.stringify(layout,null,2));
    const errors=layout.filter(x=>x.overflow>0||x.horizontal.length);
    console.log(JSON.stringify({pages:layout.length,errors},null,2));
    if(errors.length) process.exitCode=2;
    const output=path.join(root,'output/pdf/Tabweb-Education-Business-Strategy-AR.pdf');
    await page.pdf({path:output,format:'A4',printBackground:true,preferCSSPageSize:true,displayHeaderFooter:false,tagged:true,outline:true});
    console.log(JSON.stringify({output,bytes:fs.statSync(output).size}));
  }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
