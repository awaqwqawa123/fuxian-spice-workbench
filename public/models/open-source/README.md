# 随附的开源 SPICE 模型数据

获取日期：2026-09-23。随附数据可以离线浏览、预览源码及导入工程。它们是作者公开发布的拟合模型，不是原厂完整动态模型。请按下列适用范围选择。

| 数据包 | 可导入的不同模型 | 许可 | 范围 |
|---|---:|---|---|
| gsuberland / CREE XLamp XP-E2 | 8 | CC0 1.0 | 根据手册的 25 °C 正向 I–V 曲线拟合；不含光学、热学、开关和反向特性 |
| Dusan Halicky (dvhx) / 自测二极管 | 14 | GPL-3.0 | 实测样品的正向直流模型；不含反向击穿、结电容、反向恢复与温度表征 |

另有既存的 [KiCad 包](../kicad/README.md)，包含 1N4002、FZT1049A、IRF540、IRF540N 和 IRF9540 五个独立型号，许可为 CC BY-SA 4.0。总计 3 包、27 个可导入模型。LTspice 本机模型只读扫描，另列计数，不在这里重新分发。

## 来源、原文及转换

- gsuberland 项目：<https://github.com/gsuberland/spice_models>，固定提交 `52bb96a1d1b22be83c409e40b7d7e7f05e461ba7`。保留原始 [CREE_XLamp_XP_E2.txt](gsuberland/CREE_XLamp_XP_E2.txt)、[README](gsuberland/README.md) 与完整 [CC0 许可](gsuberland/LICENSE)。[cree-xpe2.lib](gsuberland/cree-xpe2.lib) 仅提取八段 `.model` 定义，未改电气参数。RED_ORANGE 与 RED 电气定义完全相同，目录不重复计数。
- dvhx 项目：<https://github.com/dvhx/spice-diode-model-js>，固定提交 `c225e2cc483a9e950528e9cb98ae89c4e15a487a`。保留原始 [models.js](dvhx/models.js)、[README](dvhx/README.md) 与完整 [GPL-3.0 许可](dvhx/LICENSE)。该文件是作者自行测量并拟合的 IS、N、RS 数据。[measured-diodes.lib](dvhx/measured-diodes.lib) 将每个具体型号的第一组拟合参数转换为 `.model` 语法，并添加 `_IVFIT` 后缀以避免冒充完整器件模型；数值不变。未执行下载的 JavaScript。每个型号的第二拟合、没有具体型号的彩色 LED、没有击穿数据的齐纳模型均未计入。

14 个型号为：1N34A、1N4007、1N4148、1N5399、1N5408、1N5819、1N5822、ER1002CT、FR107、FR207、FR302、PR1504、SFF3DG、BAT43。ER1002CT 只表示一个二端管芯的正向曲线，不表示完整三端双管封装。

这些正向模型可以求解直流导通压降。不要用它们评估反向击穿、电源开关损耗、结电容、反向恢复、LED 热效应或光输出：相关数据并未包含。想做这些分析，应搜索和核对完整厂商模型。

所有下载文件的固定 URL、SHA-256、字节数及转换文件的 SHA-256 见 [manifest.json](manifest.json)。工作台仓库中的 `scripts/download-open-models.py` 可重现下载与格式转换；它不执行外部脚本、不拟造参数。模型的原始数据及转换结果作为独立数据分别保留上游许可与本修改说明；数据包许可不改变工作台应用源码的许可。

## 兼容和验证

27 个目录模型均通过当前 SPICE 导入器检查。该版本使用真实 ngspice 对二极管、CREE LED、NPN、N/P 功率 VDMOS 代表型号求解，并核对无未知/忽略参数。能够求解不等于模型在任何工作条件下都准确。

没有打包许可不明确的社区厂商合集。特别是 KiCad-Spice-Library 的 GPL-3.0 声明仅适用于 Scripts；其 Models 仍适用各自原作者条款，不能把整个模型文件夹称为 GPL 开源库。
