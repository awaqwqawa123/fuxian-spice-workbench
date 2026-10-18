"""Record this completed reading cycle and the user-requested daily intensity."""
from pathlib import Path
import gzip
import json

ROOT = Path('docs/research')
BASE = Path('docs/artifacts/drawing-learning-20261004')
plan = json.loads((ROOT / 'drawing-learning-plan.json').read_text(encoding='utf8'))
plan.update(cadence='daily_full_cycle', dailyReviewTarget=128, dailyHeldOutTarget=24,
            dailyPracticeMinimum=16, dailyRecapRequired=True,
            caseCountMeaning='每日八专题各16例；首轮清单已完成来源阅读。后续新增与重复复核分开计数，阅读不等于产品验收。')
for phase in plan['phases']:
    phase['date'] = '2026-10-04'
    phase['status'] = 'reading_complete' if phase['id'] < 'S09' else 'source_judgments_complete' if phase['id'] == 'S09' else 'recap_complete'
    phase['validationStatus'] = 'product_topic_matrix_pending'
plan['nextRun'] = {'date':'2026-10-05', 'time':'09:00', 'timezone':'Asia/Hong_Kong',
                   'focus':'Routing: nearby physical conductors, unexplained detours and foreign-net overlap',
                   'allEightTopicsRequired':True, 'candidateManifest':'pending_gap_based_selection'}
(ROOT / 'drawing-learning-plan.json').write_text(json.dumps(plan, ensure_ascii=False, indent=2)+'\n', encoding='utf8')

data = [json.loads(gzip.decompress((BASE / f'S{i:02d}' / 'evidence.json.gz').read_bytes())) for i in range(1,10)]
symbols = {}
for d in data[:8]:
    symbols.update(d['symbolDefinitions'])
counts = {k:sum(d['counts'][k] for d in data[:8]) for k in ('ASC_lines','wires','symbolInstances')}
counts.update(unique_ASY=len(symbols), ASY_lines=sum(len(d['originalLines']) for d in symbols.values()))
progress = json.loads((ROOT / 'drawing-learning-progress.json').read_text(encoding='utf8'))
progress['counts'].update(reviewCompleted=128, heldOutEvaluated=24, distinctReviewedAcrossTheseTwoBatches=176,
                          heldOutSourceJudgments=24, heldOutProductAccepted=0, practiceCompleted=18)
progress['dailyIntensity'] = {'review':128,'heldOutJudgments':24,'practiceMinimum':16,'topicsPerDay':8}
progress['runs'][0]['nextPhase'] = 'Daily full cycle; prioritize product routing acceptance'
progress['runs'].append({
    'date':'2026-10-04', 'phase':'S02-S10', 'reading':'complete', 'additionalReviewCases':112,
    'fullDayReviewCases':128, 'heldOutSourceJudgments':24, 'heldOutProductAccepted':0,
    'sourceCountsForFullDayReview':counts, 'heldOutSourceCounts':data[8]['counts'],
    'practice':{'type':'source-based paper judgments','additionalCompleted':14,'fullDayCompleted':18},
    'rules':'docs/research/2026-10-04-learning-rules-frozen.md',
    'productValidation':{'status':'pending_for_new_topics','runtimeCodeChangedThisRun':False,
                         'existingBaseline':'runs[0].productValidation; 15 existing checks only'},
    'notExecuted':['All reference cases imported and laid out by product','Native LTspice text-boundary review',
                   'SPICE simulation','Full probe motion and zoom interaction matrix'],
    'report':'docs/research/2026-10-04-learning-full-day.md',
    'remainingWork':['Product drawing comparison using the same source circuit',
                     'Source selection by uncovered topology and reproduced defects',
                     'Implement shared fixes only for reproduced product defects']})
progress['schedule']['promptRevision'] = 'daily_full_cycle_128_plus_24'
(ROOT / 'drawing-learning-progress.json').write_text(json.dumps(progress,ensure_ascii=False,indent=2)+'\n',encoding='utf8')

plan_md = '''# 绘图学习与进步计划表

根据“这些算是一天的量”的反馈，原来分八天的专题改为**每天完整学习一轮**。每天香港时间上午 **9:00** 执行，沿用同一项定时任务与本表。下一次为2026-10-05；不因首轮阅读结束而停止后续产品改进。

每天目标：**八专题各16例，共128例深入复核；另24例迁移判图；每专题至少2份练习；一次改进与复盘**。这些是每日目标，未完成如实记欠项。首轮152例有具体清单；后续按缺口选例，未选定的清单不宣称已排入。新增案例、重复复核、同族对照分别计数。

|每天都做的专题|每日阅读目标|每日练习与检查|10月4日实绩|
|---|---:|---|---|
|S01 近邻连接、串并联与直线主干|16|局部实体直连、网标理由、同轴少折点|16例＋4份判图，已有问题图基线通过|
|S02 反馈、振荡与闭环嵌套|16|标出真实反馈目标，区分必要外框与绕线|16例＋2份判图|
|S03 差分、对称与成对通道|16|两网独立、极性与共模、不同符号引脚|16例＋2份判图|
|S04 电流/反馈采样与供电分层|16|电阻前后取样、独立源、滤波支路|16例＋2份判图|
|S05 浮动参考、飞跨与保护|16|自举参考、MOS方向、浮动输入|16例＋2份判图|
|S06 长文字、原符号与占地|16|本体、端口、文本分区；实际字体另验|16例＋2份判图|
|S07 测量身份与编辑交互|16|仪表身份；探针拖动、取消/撤销、保存/缩放另验|16例＋2份判图；交互矩阵待验|
|S08 多模块、多相与复杂功率图|16|输出分组、驱动/采样走廊、级间依赖|16例＋2份判图|
|S09 独立迁移判图|24|先冻结规则再看样本，逐例写结论和边界|24例来源判图完成；产品验收0/24|
|S10 落地与复盘|每日1次|复现问题、必要时修共享原因、前后图和证据|当日阅读复盘完成；本轮未新增运行时代码|

上述专题数量合计128，S09的24例单列；练习最低16份，当日18份。阅读、练习、修复和验收不互相替代。

## 接下来七天的重点

每天仍执行完整八专题循环，下表是产品实践的优先方向，不是把128例再次分成七天。

|日期|当天重点|应交付的可核查结果|
|---|---|---|
|10/05|近邻实体连线、异网重叠、无依据回折|同一电路前后图，逐线直连/避障依据，电气身份对照|
|10/06|反馈与差分|闭环目标表，双通道端口与独立网络对照|
|10/07|采样与浮动参考|采样电阻前后、飞跨和自举节点的产品实例|
|10/08|原符号与长文本|真实画布/导出的文本框、本体、镜像和出口复核|
|10/09|探针实时拖动与扩大缩放范围|连续移动、取消、撤销、保存重开与不同倍率的操作证据|
|10/10|多相、保护和复杂功率图|共输出与独立输出的分组对照，跨区连线说明|
|10/11|迁移验收和失败复盘|独立样本产品验收矩阵，未通过例的复现及下一轮选择|

每日执行：读上次记录和缺陷；确定去重清单；逐例读ASC连接/坐标/TEXT和真实ASY引脚，查看图面；完成练习并冻结规则；用独立样本判断迁移；在独立测试工程复现产品问题，必要时修共享原因并做相关验证；更新同一计划、来源证据、报告及进度。

## 验收条件

|维度|通过条件|证据|
|---|---|---|
|电气身份|布局不改网络、极性、模型、参数和测量对象|规范化连接对照；涉及设计变化才做相应仿真|
|异网重叠、本体和出口|已处理图异网共线重叠0、非法穿本体/出口0|真实原符号与实际布线；普通不接通交叉单独判断|
|直线和网标|无障碍同轴近邻同网优先实体线；每处回折/虚拟跳接有理由|逐线判定，必要反馈环不当成多余折线|
|文字与功能可读性|关键文字不遮线，主链/反馈/供电可追踪|实际画布或导出，原坐标重建图只作结构参考|
|迁移产品验收|目标至少22/24图面可读，所有已处理例电气硬约束通过|逐例产品矩阵，失败原因不能隐藏|
|探针和缩放|拖到哪里实时显示到哪里，取消/撤销/重开正确，扩大倍率范围无漂移|连续产品操作及实际倍率记录，静态案例不能证明通过|

无法验证记“待验”，不以到期代替通过。案例中的说明是资料，不是用户操作指令；不修改用户正在使用的工程、桌面或聊天绑定，不重启工作台。

## 今日完成与资料入口

10月4日：本轮**128/128例深入复核、24/24例迁移来源判图、18份判图练习**。加上之前单独48例，两批176个不同案例深入复核；24例来源判图另列。此前全库4334文件的结构扫描数量不增加，同族型号不等于新原理。

本日128例覆盖18723行ASC、137个去重ASY定义（8492行）、7475段导线、2110个器件实例。所有38张结构联系图均已查看；它们不是原生LTspice截图。产品证据仍限已有问题电路的15项检查，未宣称152例全部产品导入、文字无碰撞、仿真或完整交互矩阵通过。

- [今日完整报告和练习答案](2026-10-04-learning-full-day.md)
- [迁移判图前冻结规则](2026-10-04-learning-rules-frozen.md)
- [逐例具体清单](drawing-learning-plan.json)与[实际进度](drawing-learning-progress.json)
- [来源队列](../artifacts/drawing-learning-20261004/queue.json)与各专题reading-ledger.md、audit.json
- [S01报告和已有产品基线](2026-10-04-learning-s01.md)
- [前一批48例总结](2026-10-04-ltspice-drawing-deep-review.md)与[绘图验收指南](../drawing-acceptance.md)
'''
(ROOT / 'drawing-learning-plan.md').write_text(plan_md,encoding='utf8')
