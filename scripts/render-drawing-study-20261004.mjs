import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { existsSync } from 'node:fs'
const {chromium}=await import(pathToFileURL(resolve('node_modules/playwright-core/index.mjs')).href)
const root=resolve(process.argv[2])
const sheetCount=Number(process.argv[3]??8)
if(!Number.isInteger(sheetCount)||sheetCount<1||sheetCount>32)throw new Error('Invalid sheet count')
const executablePath=['C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync)
const browser=await chromium.launch({executablePath,headless:true})
try {
  const page=await browser.newPage({viewport:{width:1536,height:1600},deviceScaleFactor:1})
  for(let i=1;i<=sheetCount;i++){
    await page.goto(pathToFileURL(resolve(root,`sheet-${i}.html`)).href)
    await page.locator('img').evaluateAll(async images=>Promise.all(images.map(image=>image.decode())))
    await page.screenshot({path:resolve(root,`sheet-${i}.png`),fullPage:true})
  }
}finally{await browser.close()}
