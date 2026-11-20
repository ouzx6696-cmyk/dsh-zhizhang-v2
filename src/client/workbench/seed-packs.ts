import type { Product } from "../../contracts/workspace-dto.ts";

export interface SeedTechniquePreset {
  readonly id: string;
  readonly title: string;
  readonly category: string;
  readonly pacing: string;
  readonly sceneTags: readonly string[];
  readonly triggerWhen: string;
  readonly executionSteps: string;
  readonly constraints: string;
  readonly antiPatterns: string;
}

export interface SeedPack {
  readonly id: string;
  readonly product: Product;
  readonly name: string;
  readonly summary: string;
  readonly defaultVolumeTitle: string;
  readonly defaultAuthorIntent: string;
  readonly firstChapterTitle: string;
  readonly firstChapterLead: string;
  readonly techniques: readonly SeedTechniquePreset[];
}

export const SEED_PACKS: readonly SeedPack[] = [
  {
    id: "urban-counterattack",
    product: "fanqie",
    name: "都市逆袭·高燃打脸",
    summary: "强调黄金三章强屈辱反差、微表情动作压迫与信息差反转节奏。",
    defaultVolumeTitle: "第一卷 · 潜龙微末",
    defaultAuthorIntent: "【终局方向】从遭人轻贱的底层技术人员一步步夺回话语权。【核心卖点】技术信息差反杀与冷静克制后的痛快打脸。【禁区】主角绝不无脑降智或圣母原谅。",
    firstChapterTitle: "第一章 · 退场通知",
    firstChapterLead: "雨水顺着写字楼幕墙滑落，保安把纸箱递到林远面前时，电梯厅里的窃笑声刚好停住。\n“签个字，别让保安为难。”主管陈凯没抬头，指尖在平板上划过最后一栏。\n林远低头看了一眼箱底那枚旧工牌，没急着签名，只是把手机屏幕转向了角落里的主机指示灯。",
    techniques: [
      {
        id: "uc-micro-action",
        title: "冷压反击·微动作立威",
        category: "conflict",
        pacing: "快爽",
        sceneTags: ["打脸", "对峙", "都市"],
        triggerWhen: "反派当众羞辱或试图强压主角签字/让步时",
        executionSteps: "1. 先给反派特写动作（敲桌、哂笑）制造短促屈辱感；2. 主角沉默 1 句并抛出一处只有核心知情者懂的关键物件/数据细节；3. 用周围旁观者神色变化完成第一波反转定格。",
        constraints: "主角台词不超过 25 字，禁止长篇大论说教",
        antiPatterns: "禁止出现“嘴角勾起一抹冷笑”“五味杂陈”",
      },
      {
        id: "uc-hook-end",
        title: "章末硬悬念断章法",
        category: "cliffhanger",
        pacing: "快爽",
        sceneTags: ["断章", "悬念"],
        triggerWhen: "章节最后 120 字需要拉升次章追读欲时",
        executionSteps: "在危机刚化解、众人松口气的瞬间，切入一条短信、来电或异常读数，留下明确的时间倒计时或未知来客名字。",
        constraints: "最后一句话控制在 18 字以内",
        antiPatterns: "不要在章末写哲学感悟或全知视角的命运感叹",
      },
    ],
  },
  {
    id: "xuanhuan-upgrade",
    product: "fanqie",
    name: "玄幻升级·宗门暗流",
    summary: "重剑气/灵压具象化描写，控制设定灌输密度，突出战力越阶与底牌藏拙。",
    defaultVolumeTitle: "第一卷 · 青萍之末",
    defaultAuthorIntent: "【终局方向】打破旧宗门灵脉封锁，重铸破碎剑道传承。【核心卖点】底牌克敌与跨阶斩杀的反差感。【禁区】开篇前千字禁止一次性抛出超过两个大境界体系名词。",
    firstChapterTitle: "第一章 · 断剑试锋",
    firstChapterLead: "寒霜贴着青石阶蔓上脚踝，演武场西侧的测灵碑却连半点微光都没亮起。\n执事长老正要合上名册，人群后方却忽然有人轻咳了一声——林砚怀里那截生锈的断剑，剑鞘微微震颤了一下。",
    techniques: [
      {
        id: "xh-concrete-qi",
        title: "灵压五感具象化",
        category: "atmosphere",
        pacing: "快爽",
        sceneTags: ["战斗", "修炼", "对决"],
        triggerWhen: "描写出手威压、功法运转或境界差距时",
        executionSteps: "不用形容词硬夸“恐怖如斯”，改写寒霜冻裂茶盏、剑风削断衣角一缕发丝、石阶灰尘被气浪压成放射状。",
        constraints: "先写环境物理反馈，再写对手反应",
        antiPatterns: "避免“恐怖如斯”“倒吸一口凉气”“瞳孔骤然一缩”",
      },
      {
        id: "xh-info-drip",
        title: "冲突中渗入世界观",
        category: "opening",
        pacing: "稳推",
        sceneTags: ["开篇", "世界观"],
        triggerWhen: "需要交代宗门规矩、灵石体系或禁制设定时",
        executionSteps: "每次只通过角色当下吃亏或交易的 1 个具体代价引出规则，严禁超过 3 句连续旁白解释。",
        constraints: "单段设定说明不超过 80 字",
        antiPatterns: "禁止开篇百科全书式背景交代",
      },
    ],
  },
  {
    id: "suspense-mystery",
    product: "fanqie",
    name: "悬疑刑侦·线索闭环",
    summary: "强绑定人物知情时间线与物证细节，适合多视角推理与长线伏笔。",
    defaultVolumeTitle: "第一案 · 雨夜钟声",
    defaultAuthorIntent: "【终局方向】拼合十二年前旧案与当下连环现场的真实因果。【核心卖点】物证矛盾点与审讯心理博弈。【禁区】侦探与凶手在未获物证前绝不靠“直觉猜对”。",
    firstChapterTitle: "第一章 · 停在十一点的表",
    firstChapterLead: "法医把证物袋举到无影灯下时，沈默先注意到的不是死者袖口的泥点，而是墙角那台老式挂钟——玻璃裂成了蛛网，秒针却还在走。",
    techniques: [
      {
        id: "sm-clue-anchor",
        title: "物证三要素锚定",
        category: "foreshadow",
        pacing: "慢燃",
        sceneTags: ["推理", "物证", "伏笔"],
        triggerWhen: "现场勘查或埋设后期破案线索时",
        executionSteps: "同时交代该物件的物理反常细节、发现时在场人物与环境噪音，把线索自然藏在日常排查动作中。",
        constraints: "严禁旁白直接点明“这将在日后成为关键证据”",
        antiPatterns: "禁止角色凭空“灵光一闪”破案",
      },
    ],
  },
  {
    id: "toutiao-commentary",
    product: "toutiao",
    name: "头条深度·观点锐评",
    summary: "适配 1000–2500 字短长图文，强化前三句抓手、证据句锚定与克制收束。",
    defaultVolumeTitle: "",
    defaultAuthorIntent: "保持客观克制、结论以可核查事件与具体数字支撑、不写空洞口号。",
    firstChapterTitle: "拆解一线真实体感：为何看似划算的选择往往最消耗注意力",
    firstChapterLead: "很多人复盘一件事是否值得投入时，往往只盯着账面成本算加减，却忽略了隐性返工带来的注意力损耗。",
    techniques: [
      {
        id: "tt-lead-contrast",
        title: "前三句反差入题法",
        category: "opening",
        pacing: "快爽",
        sceneTags: ["开头", "图文"],
        triggerWhen: "撰写头条短/长图文导语时",
        executionSteps: "第 1 句摆出一个反常识的常见现象，第 2 句点明多数人的直觉误判，第 3 句给出本文核心切口。",
        constraints: "导语总字数控制在 120 字以内",
        antiPatterns: "禁止出现“随着时代的发展”“综上所述”“值得注意的是”",
      },
    ],
  },
];

export const DEMO_BOOK_PRESET = {
  product: "fanqie" as Product,
  projectName: "示例书 · 灰塔长夜",
  authorIntent: "【终局方向】揭开灰塔三层时钟停摆之谜。【核心卖点】人物知情差与伏笔逐章兑现。【禁区】禁止全知视角提前剧透。",
  currentFocus: "第 1–2 章聚焦男主林砚初入灰塔旧档案馆，围绕铜钥匙归属展开首次信息差试探。",
  volumeTitle: "第一卷 · 雾中档案馆",
  actTitle: "第一幕 · 失踪的编目员",
  chapters: [
    {
      title: "第一章 · 湿透的借阅卡",
      body: "十一点零七分，档案馆铁门上的铜铃响了两次。\n林砚把湿漉漉的风衣挂在门后，指尖在桌角停了一瞬——前任编目员留下的借阅卡还压在玻璃板下，墨迹晕开了一半，日期却停在三天后。\n“别碰三号柜。”门外传来值夜老人沙哑的声音。",
      summary: "雨夜林砚接手灰塔档案馆，发现日期写着三天后的异常借阅卡，值夜老人警告不要触碰三号柜。",
    },
    {
      title: "第二章 · 三号柜的回声",
      body: "灯绳拉响的时候，柜门缝里渗出一股淡淡的松节油味。\n林砚没有立刻拉抽屉，而是先掏出随身带着的小镜片，借着走廊斜射进来的冷光，看清了锁孔内侧一道极浅的新划痕。",
      summary: "林砚排查三号柜，发现松节油味与锁孔新划痕，确认近期有人撬动过档案柜。",
    },
  ],
  technique: SEED_PACKS[2].techniques[0],
} as const;
