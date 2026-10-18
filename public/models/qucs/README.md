# Qucs-S 厂商器件参考模型

可离线选择 594 个模型：原有 172 个 NPN/PNP、121 个二极管、169 个 N/P 沟道功率 VDMOS，加上 38 个肖特基二极管和 94 个完整稳压二极管网络。另有 24 个宏模型按型号从固定版本下载，原文不随工作台分发。

这些是 **Qucs-S 社区参考库中的具体厂商型号**，并不是从厂商官网直接获得或经厂商认证的原始模型。`_QUCS` 后缀明确区分这一来源，避免覆盖工程已有定义或本机 LTspice 原始模型。库中的 `mfg` 保留 Qucs 的厂商描述；IR 库标为 International Rectifier / Infineon 系列。

## 来源和许可

固定上游提交：`e0c0e154edb4f8403d53c5c5601c2ee133c9e970`；下载日期：2026-09-24。

- [Qucs-S Transistors.lib](https://github.com/ra3xdh/qucs_s/blob/e0c0e154edb4f8403d53c5c5601c2ee133c9e970/library/Transistors.lib)
- [Qucs-S Diodes.lib](https://github.com/ra3xdh/qucs_s/blob/e0c0e154edb4f8403d53c5c5601c2ee133c9e970/library/Diodes.lib)
- [Qucs-S VDMOS_IR.lib](https://github.com/ra3xdh/qucs_s/blob/e0c0e154edb4f8403d53c5c5601c2ee133c9e970/library/VDMOS_IR.lib)
- [Qucs-S COPYING](https://github.com/ra3xdh/qucs_s/blob/e0c0e154edb4f8403d53c5c5601c2ee133c9e970/COPYING)

本模型数据包及其转换脚本以 **GPL-2.0-or-later** 分发。完整许可证见 [COPYING](COPYING)，原始模型文件和参数顺序的上游组件定义位于 `upstream/`，保留原始作者署名。`manifest.json` 记录每份原始下载文件的 URL、大小、SHA-256，以及每个生成模型的来源和跳过记录。模型数据许可不改变独立工作台代码的许可。

## 可复现转换与边界

在项目目录运行 `python scripts/build-qucs-models.py`，从随附的固定源文件离线重建 `.lib` 文件。转换依据同版本的 Qucs-S `bjtsub.cpp`、`diode.cpp`、`vdmos.cpp` 中参数顺序及默认值；`bjt.cpp` 说明其 SPICE 导出映射，`component.cpp` 记录旧库字段版本迁移。

- 电气常数保持原值，仅序列化为 ngspice `.model`，并规范化 Qucs `pF` 等单位写法。未修改曲线参数。
- 文件省略的尾部字段使用该版本 Qucs 构造器公开的默认值；没有推测芯片数据手册参数。
- 只接收默认面积/并联倍率 = 1、默认无额外噪声项和关闭自热的独立器件。非默认不兼容项会跳过整条记录，原因保留在清单，未删掉参数来假装兼容。
- 旧版二极管库 17 / 27 字段中的 Temp 位于第 12 项，按旧版字段顺序显式恢复，不能当作新版 IKF 参数。缺少 IKF 时对应 Qucs 默认的无限高注入拐点；按 Qucs SPICE 导出规则省略 IKF=0，避免 ngspice 将显式零错误用于求解。
- 二极管保留 ISR/NR；Qucs 的 Tbv/Trs 分别映射为 ngspice TBV1/TRS1。非零外接并联电容 Cp 或无法表示的动态温度项不导入。
- 一个条目只表示一个三极管或二极管管芯、一个三端功率 MOS。双管/多管芯封装型号仍须按数据手册组合，不代表完整封装。
- VDMOS 保留其非线性电容和体二极管定义；不启用热端口、自热或封装热网络。
- 准确度以来源及工作条件为准；代表型号已实际通过 ngspice 工作点/DC 验证，这不构成全部工况的厂商精度认证。

## 2026-10-02 扩展

| 类别 | 本地随附 | 固定版本按型号下载 |
| --- | ---: | ---: |
| 肖特基二极管 | 38 | — |
| 稳压二极管（保留双二极管、参考源等完整网络） | 94 | — |
| SpiceOpamp 运放/比较器单通道参考 | — | 8 |
| VoltageComparators 电压比较器 | — | 3 |
| 电压基准 | — | 3 |
| 线性稳压器 | — | 3 |
| 光耦 | — | 1 |
| 晶闸管/双向触发器 | — | 6 |

运行 `python scripts/build-qucs-models.py` 后，运行 `node --import tsx scripts/build-qucs-expansion.ts` 离线重建扩展。`upstream/expansion-sources.json` 固定原始 Git blob SHA-1；`expansion-manifest.json` 记录输入/输出 SHA-256、脚位和整条跳过原因。稳压网络依照 `diode.cpp` 的端口顺序 1,0 将原生 K,A 转为 SPICE A,K，Vdc 顺序依照随附 `volt_dc.cpp` 保持不变。公开端口明确标为 K,A。飞法拉 `f` 保留其 10^-15 倍率，不能当作法拉单位 `F` 去掉。

两条与已有 BAS40/BAS70 同名的来源保留原条目。SD103ASDM 和 SD103ATW 的上游 Cj0 写作 `29.2`，对应 29.2 F，暂时隔离；没有猜测补上 pico 后缀。肖特基文件未说明厂商时显示“未注明厂商”，不会冒充厂商原件。

宏模型的原作者/厂商授权与 Qucs 软件 GPL 分开处理。部分上游宏库含 TI/Avago 版权说明，其他文件也没有独立再分发授权，因此本项目仅提供 `server/qucs-model-catalog.json` 的固定文件路径、型号、大小、哈希和已知兼容边界。用户选中后下载原件并保留出处；工作台不附带原文或声称厂商模型以 GPL 授权。转换器只处理白名单中的完整组件，保留依赖，命名隔离，记录来源中 `.ends` 标签修正及单位规范化。ngspice WASM 无 XSPICE，常数系数的 POLY 源按标准多项式顺序等价转换为行为源，不删除系数、极点、电容或反馈网络。

TL431 以 `TL431_QUCS` 提供。固定来源 `VoltageReferences.lib` 已含完整 `nTL431`、NPN/PNP 模型卡及全部四个晶体管网络；此前“依赖 .model 0”来自解析器把可选衬底节点当成模型名，并非上游缺少文件。现在共享解析器和命名转换器共同识别带衬底节点的 Q 语句。公开根直接使用完整 `nTL431`，端口按上游顺序为 CATHODE（阴极）、ANODE（阳极）、REF（参考端），保留各晶体管衬底接地和全部原始电气常数。Qucs 的绘图包装定义仍留在下载文本中，未作为额外接地引脚暴露。原文误写的 `.ends TL431` 仅修正为对应声明名，转换记录随下载保留。该社区晶体管级模型不代表所有厂家的 TL431 实物，也未新增精度或全工况认证。

JFET 原生库中 ISR/NR/M/温度物理项、参数化开关密集的 TI 宏模型、外部附件依赖以及不能完整解析的模型暂未放行；对应宏库跳过原因留在索引。单通道 LM324/LM358/LM339 等不表示整颗多通道芯片，更不替代封装引脚核对。

在停止追加检查之前，代表模型已实际运行当前 eecircuit-engine 的 ngspice：1N5711 正向工作点 0.5141 V；BZT52C10T 反向网络 10.0818 V；LM358 低频跟随器 AC 增益约 0.999934；AD581 10.0006 V；LM7805 5.0028 V；另运行 LM339、4N25 与 2N1595 的瞬态切换/锁存。这是代表工况运行证据，其他型号及所有温度、频率、极限工况并未得到认证。
