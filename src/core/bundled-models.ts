import type { SpiceModelSource } from './spice-models'
import { isInstalledTinaSource, isOwnedPspiceSource } from './installed-model-source'
import { preferredModelLibrary } from './model-source-policy'
import { qucsExpandedPackages, qucsExpandedFiles } from './qucs-model-expansion'

/** Fixed registry: neither the browser nor the assistant can choose filesystem paths. */
export const bundledModelPackages = [
  ...qucsExpandedPackages,
  {id:'qucs-bjt',name:'Qucs · 厂商三极管参考',license:'GPL-2.0-or-later',detail:'172 个 Diodes、Zetex、Philips NPN / PNP 单管芯模型，保留完整电气参数。',notice:'来自 Qucs-S 社区参考库，并非厂商官网原件；_QUCS 后缀区分来源。',documentation:'/models/qucs/README.md'},
  {id:'qucs-diode',name:'Qucs · 厂商二极管参考',license:'GPL-2.0-or-later',detail:'121 个 Diodes 与 Philips 整流、开关、肖特基二极管参考模型。',notice:'仅表示单个二极管；多管芯封装须自行组合并核对引脚。',documentation:'/models/qucs/README.md'},
  {id:'qucs-mos',name:'Qucs · IR 功率 MOS 参考',license:'GPL-2.0-or-later',detail:'169 个 International Rectifier / Infineon 系列 N/P 沟道 VDMOS 模型。',notice:'Qucs-S 社区参考库的单管芯模型，使用 ngspice 原生 VDMOS；不含自热。',documentation:'/models/qucs/README.md'},
  {id:'kicad',name:'KiCad 离散器件',license:'CC BY-SA 4.0',detail:'整流二极管、NPN 与 N/P 功率 MOS；包含电容和动态参数。',notice:'使用前核对型号、引脚和适用工作条件。',documentation:'/models/kicad/README.md'},
  {id:'gsuberland',name:'CREE XP-E2 LED',license:'CC0 1.0',detail:'8 个不同颜色的正向 I–V 拟合，保留作者依据数据手册得到的参数。',notice:'仅 25 °C 正向直流；不含光学、热学、结电容或开关特性。',documentation:'/models/open-source/README.md'},
  {id:'dvhx',name:'实测二极管 · 正向 DC',license:'GPL-3.0',detail:'14 个具体型号的实测正向曲线，型号后缀 _IVFIT 明确标识用途。',notice:'仅实测样品正向直流；不含击穿、结电容、反向恢复或温度特性。ER1002CT 只表示单管芯，不表示双管封装。',documentation:'/models/open-source/README.md'},
] as const
const kicadRevision='b4eadf61cca001c6285c3706d207606558cd4c97'
const kicadFiles=[
  ['1N4002.lib','power_supplies/LM317_power_supply/1N4002.lib'],
  ['fzt1049a.lib','laser_driver/fzt1049a.lib'],
  ['IRF-Power-VDMOS.mod','power_supplies/buck_conv/IRF-Power-VDMOS.mod'],
] as const
export const bundledModelFiles:{packageId:string;file:string;source:SpiceModelSource;excludedIds?:string[]}[]=[
  ...qucsExpandedFiles,
  ...([['qucs-bjt','transistors.lib','Transistors.lib'],['qucs-diode','diodes.lib','Diodes.lib'],['qucs-mos','power-mos.lib','VDMOS_IR.lib']] as const).map(([packageId,file,upstream])=>({packageId,file:`qucs/${file}`,source:{label:`离线开源库 / Qucs-S 厂商参考 / ${upstream}`,url:`https://raw.githubusercontent.com/ra3xdh/qucs_s/e0c0e154edb4f8403d53c5c5601c2ee133c9e970/library/${upstream}`,license:'GPL-2.0-or-later',attribution:'Qucs-S project and contributors；由已公开的 Qucs 参数表转换，电气常数未调参，名称添加 _QUCS；不是厂商官网原件。仅表示单管芯，封装脚位另行核对；VDMOS 不含自热。源文件、转换脚本和许可随库提供。'}})),
  ...kicadFiles.map(([file,path])=>({packageId:'kicad',file:`kicad/${file}`,source:{label:`离线开源库 / KiCad / ${file}`,url:`https://raw.githubusercontent.com/KiCad/kicad-source-mirror/${kicadRevision}/demos/simulation/${path}`,license:'CC BY-SA 4.0',attribution:'KiCad project and contributors；模型参数未修改。'},...(file.endsWith('.mod')?{excludedIds:['IRF9540_2','IRF9540_3']}: {})})),
  {packageId:'gsuberland',file:'open-source/gsuberland/cree-xpe2.lib',source:{label:'离线开源库 / CREE XP-E2 LED',url:'https://raw.githubusercontent.com/gsuberland/spice_models/52bb96a1d1b22be83c409e40b7d7e7f05e461ba7/LEDs/CREE_XLamp_XP_E2.txt',license:'CC0 1.0',attribution:'gsuberland；按 CREE 手册 25 °C 正向曲线拟合，仅提取定义并去除相同 RED_ORANGE 副本，电气参数未修改。仅正向直流，未表征热学、光学或动态特性。'}},
  {packageId:'dvhx',file:'open-source/dvhx/measured-diodes.lib',source:{label:'离线开源库 / dvhx 实测正向 DC',url:'https://raw.githubusercontent.com/dvhx/spice-diode-model-js/c225e2cc483a9e950528e9cb98ae89c4e15a489a/models.js',license:'GPL-3.0',attribution:'Dusan Halicky (dvhx)；实测样品拟合。数值未修改，转换为 .model 并加 _IVFIT 后缀；仅正向直流，不含击穿、结电容、反向恢复或温度特性。'}},
]
export function isBundledModelSource(source:SpiceModelSource):boolean {
  return bundledModelFiles.some(file=>file.source.label===source?.label&&file.source.url===source?.url&&file.source.license===source?.license&&file.source.attribution===source?.attribution)
}
export function modelPackageId(source:SpiceModelSource):string {
  if(isInstalledTinaSource(source))return 'tina'
  if(isOwnedPspiceSource(source))return 'pspice'
  return bundledModelFiles.find(file=>file.source.label===source.label&&file.source.url===source.url)?.packageId??preferredModelLibrary(source)??'other'
}
