import { deviceCatalog, pinsFor } from './devices'
import { GRID, pinPosition, type Drawing } from './drawing'
import { terminalLeadDirection } from './wire-lead-route'

/**
 * Bundled copy of the canonical runtime excerpt in docs/drawing-guide.md.
 * tests/agent-drawing-guidance.test.ts enforces exact agreement and verifies
 * the real inspect_circuit / Codex protocol payloads, not just this constant.
 * Keep this browser/server-safe: restricted agents cannot read local docs.
 */
export const agentDrawingInstructions = `原理图绘制指导（drawing-guide.md D01–D10；模式见 drawing-patterns.md；验收见 drawing-acceptance.md）：
先读取当前项目和真实模型引脚，确认本轮是新设计还是纯排版。按已确认的信号/功率、反馈、供电、偏置和控制关系分区；选择对应电路画法。先放功能块及主通道，再放外围回路和文字。导线从真实引脚出口向外引出，并从目标引脚外侧接回；不穿本体和文字，不把交叉自动接通。保留参数、模型、网名、探针及用户手工约束。生成可审阅候选，先检验电气与几何，再说明实际改动；无变化或有冲突如实报告。不要把执行排版算法当成验收通过。
重画反馈：以本轮用户具体要求和 inspect_circuit 返回的完整候选为准；它可能包含尚未应用的新器件，不要退回历史画布丢失候选。先指出拥挤、反馈混杂、穿线等有证据的问题，再选择不同的局部策略。不能只随机挪动、整体平移或反复套同一分层算法；保留已认可区域。纯布局不改器件参数、真实端口连接、模型、源表达式、分析设置和网名，不推断或交换引脚身份。
纯重画操作：复制完整 drawing，在原对象上只改坐标、rotation/mirrored、bend/waypoints；保留 devices.params、labels、sourceId、output 及其他非几何字段，不按位号/数值摘要重建器件。优先保持导线 ID 与 from/to；等价拆分须核对引脚网络并迁移网标、输出和探针引用。提交拒绝则候选未变，按具体字段及前后差异修正重试，不删参数绕过检查；提交成功、重新检查有实际几何变化且电气校验通过后，才说明重画候选已生成。
真实探针：新建仿真电路时，在绘图阶段按观察目标调用 set_measurement_probes({probes:[...]}) 保存完整 Project.probes（最多64项），保留已有有效探针。电压为 kind:"voltage" + positive；差分加 negative，测正端减负端；器件电流为 kind:"current" + device，导线电流必须确认真实支路及方向，不能取邻近器件替代。drawing.output 参考输出和文字网标不等于测量探针。缓启动可观察 Gate、LOAD_DRAIN、R1负载电流，按目标再加负载差分，不要求所有电路固定四针。纯重画保留ID、类型、测量端与方向，只调整视觉锚点/标牌偏移并避让。错误按具体字段修正，设置后 inspect_circuit 核对；工具未列出时报告能力限制，不能假称已放置或已测量。
波形配置：生成仿真电路时，用 configure_waveforms 一并配置 Project.waveformSetup 的 profiles/diagrams；图框位于原理图同一画布并避开电路和标牌。每图绑定一个真实配置，图内1/2/4个plot共享该配置，曲线使用实际 probe:P1 等ID。分别核对分析区间/步长与归一化domain显示窗口，不能把局部放大当成缩短仿真；AC窗口按对数频率。波形配置的曲线清单、图框位置尺寸、plot布局、显示区间和光标信息放在图框内；对话和候选摘要关于配置只给仿真类型、分析范围与步长，不逐项展开波形配置。保留必要的设计解释及真实仿真结论。无匹配Result只显示配置，不画假曲线；仅真实求解成功才报告结果。纯重画保留既有配置、曲线和窗口，应用/撤销/保存一起核对。
几何：drawingGeometry.devices 提供本轮器件旋转/镜像后的引脚坐标及 outward 朝外单位向量；移动后重新计算。路线 p0…pn 的首段 p1-p0 沿起点 outward，末端 pn-1-pn 沿终点 outward，不能再次反转目标向量。按 20 单位电气栅格，先留 1–2 格引脚通道再转弯，显式 waypoints 均正交。两端本体同样参与避障；不同网不能共线重合。近邻同网优先用直线或最少拐点的显式导线，局部支路汇入公共线；只有距离远或受障碍限制才用同名网标。两端共轴且通道畅通就直连，不为避开普通交叉添加绕路。位号、数值、长型号和多行文字也要留空间，不能只按中心间距判断。
模式摘要（按真实连接选择，可组合，不强制全部电路横向分层）：RC/RLC 梯形串联沿主轴、并联支路朝参考节点，浮地或桥式不可套此规则；运放先核对正负输入及供电，反馈走外圈，Sallen-Key/TIA 的多条反馈各留通道；振荡器/PLL 保留闭环，无输入时不虚构分层根；BJT/MOS 差分对、电流镜保留成对关系和尾支路；开关/保护保留 D/G/S、背靠背方向，功率主路与控制分区；LDO 的输入、输出、参考与去耦按真引脚安排；Buck/Boost/充电器的功率、采样反馈与控制分区，不按都是电感/电容猜用途；变压器/反激保留绕组、同名端与磁耦合，不能增加电连接；多相按相位单元重复，多输出按各自反馈分组，差分驱动/ADC 保留正负通路；对照块、测量和同页波形各留独立空间，不把图框当作电气节点。
负载与电流路径：每次生成或重画都先从真实网表和设计目标确认供电、保护、负载、MOS D/G/S、回流顺序，再沿实际主电流路径安排视觉顺序与器件朝向；负载通常放在该路径的输出端，闭环、桥式和多输出电路按各自真实支路处理。低边 NMOS 可为供电→负载→D→S→地；高边 NMOS 源极跟随可为供电→D→S→负载→地，S 到地的电阻可能正是负载，不能擅改拓扑。向右的主路令 D 在左、S 在右、负载在右端接地；向下的主路令 D 在上、S 在下，Gate 放控制侧。仅改接时才重新 validate_circuit 与 simulate_circuit；高边 PMOS 按实际 S/D 另核对。
几何检查：inspect_circuit 和 validate_circuit 返回 drawingQuality，列出冲突类型、对象ID和估计位置；按检查修正后再次读取。valid 只表示电气有效，非图面合格；complete=false 或 omitted>0 表示结果不完整，估计零冲突也不等于浏览器验收。
提交与验收：调用 replace_candidate 提交完整 drawing 后再次 inspect_circuit / validate_circuit，核对电气等价、引脚出口、正交、本体/文字避让及功能分区，说明具体调整与仍有的冲突。结果只是可预览、应用和撤销的候选，不声称已改动画布；无实际几何变化如实说明。纯排版不必重复仿真，电气修改才需要真实 ngspice 验证。当前工具只提供结构和引脚几何，不提供浏览器截图或实测文字边界；未收到图片就不能声称看过图片、已人工审图或零文字碰撞。`

/** Geometry of the current candidate, including rotations and mirrors already applied. */
export function agentDrawingGeometry(drawing:Drawing | undefined) {
  return {
    coordinateSpace:'drawing',
    grid:GRID,
    visualEvidence:'结构与引脚几何；不含截图、实际文字边界或视觉验收结论。',
    devices:(drawing?.devices ?? []).map(device => ({
      id:device.id,
      pins:pinsFor(device).map(pin => {
        const position = pinPosition(device,pin)
        return {pin,name:device.kind==='X'?device.pins?.[pin]??deviceCatalog.X.pins[pin]:deviceCatalog[device.kind].pins[pin],...position,outward:terminalLeadDirection(drawing!,{device:device.id,pin})??{x:0,y:0}}
      }),
    })),
  }
}
