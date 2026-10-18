# KiCad 示例中的 SPICE 模型

这些文件是从 KiCad 官方源码镜像的仿真示例下载的完整模型数据，保留了上游原始字节、全部模型参数和文件名。它们用于展示真实外部模型的导入与仿真；不是新增的器件分类，也不意味着厂商认证、实测精度保证或覆盖该型号的全部工作条件。

- 来源项目：KiCad，贡献者署名为 KiCad project and contributors。两个模型文件没有标注个人作者，不能推断其个人作者或厂商授权身份。
- 获取日期：2026-09-19。
- 固定版本：[`b4eadf61cca001c6285c3706d207606558cd4c97`](https://github.com/KiCad/kicad-source-mirror/commit/b4eadf61cca001c6285c3706d207606558cd4c97)。
- 获取方式：GitHub Contents API，在上述 commit 读取模型文件，将返回的 Base64 内容解码后按原始字节保存。
- 修改记录：模型内容未修改；本目录新增本说明、完整许可证和上游许可范围说明。

| 本地文件 | 上游文件与模型 | SPICE 电气引脚顺序 | SHA-256 |
| --- | --- | --- | --- |
| [1N4002.lib](./1N4002.lib) | [demos/simulation/power_supplies/LM317_power_supply/1N4002.lib](https://github.com/KiCad/kicad-source-mirror/blob/b4eadf61cca001c6285c3706d207606558cd4c97/demos/simulation/power_supplies/LM317_power_supply/1N4002.lib)，`.model 1N4002 D` | 阳极 A、阴极 K | `F1C010FABA354671FCD72CF227B33A28B21281A2F05D40FA07ED08DCB7E4A0AA` |
| [fzt1049a.lib](./fzt1049a.lib) | [demos/simulation/laser_driver/fzt1049a.lib](https://github.com/KiCad/kicad-source-mirror/blob/b4eadf61cca001c6285c3706d207606558cd4c97/demos/simulation/laser_driver/fzt1049a.lib)，`.model FZT1049A NPN` | 集电极 C、基极 B、发射极 E；不是物理封装脚号 | `C7060C71AC0E6C7BFA553362347495DD3D3D1B3758D7D746AED6BC95998786DF` |
| [IRF-Power-VDMOS.mod](./IRF-Power-VDMOS.mod) | [demos/simulation/power_supplies/buck_conv/IRF-Power-VDMOS.mod](https://github.com/KiCad/kicad-source-mirror/blob/b4eadf61cca001c6285c3706d207606558cd4c97/demos/simulation/power_supplies/buck_conv/IRF-Power-VDMOS.mod)，IRF540 / IRF540N / IRF9540 | 原生三端功率 MOS：D、G、S，无 W/L 实例缩放 | `840295BA890BAAD25B3921FB9AB17F6174CF9673F58FDE37F26BC3CA1CDDE596` |

`IRF-Power-VDMOS.mod` 于 2026-09-20 从以上固定版本的 GitHub raw 文件下载，字节未修改。同目录许可范围声明覆盖此 `demos/*` 示例；文件没有另列厂商授权条款。它有五条 `.model`，其中 IRF9540_1、IRF9540_2、IRF9540_3 是同一个 P 沟道型号的三种等效语法示例，不能当作三种不同器件。界面默认仅选 IRF9540_1、IRF540、IRF540N 三种型号。归一化后的工程模型保留电气参数、极性、目录信息、来源与许可。

## 许可证与署名

分发依据为固定版本的 [KiCad LICENSE.README](https://github.com/KiCad/kicad-source-mirror/blob/b4eadf61cca001c6285c3706d207606558cd4c97/LICENSE.README)，其中明确写明：

> Licensed under CC BY-SA 4.0:
> - All the demo files provided in demos/*

模型作为独立数据文件按 **Creative Commons Attribution-ShareAlike 4.0 International（CC BY-SA 4.0）**提供。完整法律文本见 [LICENSE.CC-BY-SA-4.0](./LICENSE.CC-BY-SA-4.0)，上游许可范围说明的原始副本见 [UPSTREAM-LICENSE.README](./UPSTREAM-LICENSE.README)。可读的许可概要见 [Creative Commons 官方页面](https://creativecommons.org/licenses/by-sa/4.0/)。再分发时保留以上来源、署名和许可说明；如修改模型，应注明修改，并遵守此许可的相同方式共享要求。

该许可说明针对这里的独立模型数据，不将工作台应用源码改为 CC BY-SA。KiCad 其他目录和含独立厂商许可声明的其他模型不能仅凭这两个文件的许可推定可按相同条件分发。

## 模型能力

`1N4002` 使用标准二极管参数，包含直流、串联电阻、结电容、反向击穿、温度系数与渡越时间等参数。`FZT1049A` 使用标准 NPN 双极晶体管参数，包含正反向电流增益、Early 效应、电阻、结电容与渡越时间等参数。实际适用范围应结合模型来源与器件数据手册判断。

VDMOS 模型使用 ngspice 原生功率 MOS 方程，保留栅电阻、导通电阻、非线性电容和体二极管，不会降级成普通 Level 1 MOS；当前三端符号不启用自热。三个不同型号已经经过真实 ngspice DC 开关曲线测试，其中包含 P 沟道的反向供电测试。

这是模型文件中的逻辑端子顺序；要连接真实元器件的封装，仍需按对应器件数据手册匹配物理引脚。
