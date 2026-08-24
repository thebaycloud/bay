import type { Messages } from "../types";

const zhHans: Messages = {
  nav: {
    product: "产品",
    ship: "发布",
    services: "服务",
    fixes: "修复",
    agents: "智能体",
    templates: "模板",
    pricing: "价格",
    resources: "资源",
    changelog: "更新日志",
    docs: "文档",
    community: "社区",
    myApps: "我的应用",
    homeAria: "{brand} 首页",
  },

  hero: {
    h1: "智能体时代的云",
    p: "{brand} 运行你用编程智能体构建的应用。通过智能体或终端部署，即可获得实时网址、Postgres、Redis 和存储。",
  },

  onboard: {
    label: "接入你的智能体",
    copied: "已复制。粘贴给你的智能体。",
    aria: "复制接入编程智能体的提示词",
  },

  intro: {
    h2: "每个应用都从这里发布",
    p: "无需设置。每个应用发布时就有可分享的网址，数据库从首次部署起备份。此后我们持续监控，并用直白文字说明故障，而不是只给错误代码。",
    link: "接入你的智能体",
  },

  worksWith: {
    line: "支持你正在使用的编程智能体",
  },

  features: {
    h2: "应用需要的不只是一台服务器",
    cta: "发布你的应用",
    ship: {
      h: "一条命令即可发布",
      p: "{brand} 构建应用并返回实时网址。支持 Next、Django、Rails、Go 或任何容器应用。",
    },
    services: {
      h: "构建所有服务",
      p: "Postgres、Redis 和对象存储随应用启动。Worker 和 cron 在旁运行。你无需配置。",
    },
    fixes: {
      h: "把修复方案交给智能体",
      p: "{brand} 捕获生产环境错误，并将其转成编程智能体可执行的指令。",
    },
  },

  mock: {
    files: "文件",
    processes: "进程",
    cacheAndQueues: "缓存和队列",
    live: "线上",
    forYourAgent: "提供给你的智能体",
    diagnosis:
      "迁移从未运行，因此架构为空。添加发布步骤，在 Web 进程启动前运行迁移，然后重新部署。",
  },

  interfaces: {
    h2: "用 MCP 和 CLI，不用控制面板",
    cli: {
      title: "命令行",
      p: "能运行命令的工具都能操作你的基础设施",
      pmAria: "包管理器",
      copyAria: "复制命令",
      copiedAria: "已复制",
    },
    commands: {
      ship: "发布当前文件夹",
      logs: "查看生产环境实际记录",
      errors: "查看当前故障",
      diagnose: "生成智能体可执行的修复方案",
      rollback: "回退到可用版本",
      env: "密钥绝不写入代码",
      exec: "打开线上应用的 shell",
    },
    mcp: {
      soon: "即将推出",
      p: "你的智能体把 {brand} 作为工具调用，而不是启动 shell。无需离开编辑器，就能部署、读取日志并应用修复。",
      cta: "阅读智能体手册",
    },
  },

  templatesSection: {
    h2: "自行托管常用软件",
    all: "全部模板",
    cardCta: "自行托管",
    shotAlt: "{name} 运行界面",
  },

  oss: {
    h2: "自行托管首 1 年免费",
    p: "我们热爱开源，也希望任何人都能更轻松地运行软件。",
    cta: "自行托管任意软件",
  },

  closing: {
    h2: "把你的应用带到这里",
  },

  footer: {
    tagline: "智能体时代的云",
    product: "产品",
    whatYouGet: "包含内容",
    pricing: "价格",
    build: "构建",
    agentManual: "智能体手册",
    shipAnApp: "发布应用",
    signIn: "登录",
    company: "公司",
    contact: "联系",
    github: "GitHub",
    rights: "© {year} Supersonic Software, Inc.",
    languageAria: "语言",
    rss: "RSS",
  },

  pricing: {
    metaTitle: "价格",
    metaDescription: "永久免费，无需支付基础设施账单。",
    h1: "永久免费。没有基础设施账单。",
    p: "云资源已包含，你不会收到 AWS 账单。免费方案的应用不会休眠或过期。",
    per: "/",
    footnote:
      "在任一方案基础上，自行托管开源项目首年免费。无需申请，部署时会自动识别。",
    plans: {
      free: {
        name: "免费",
        unit: "永久",
        desc: "三个真实应用，包含数据库、网址，并可分享给任何人。",
        rows: [
          "3 个应用",
          "包含数据库和存储",
          "通过电子邮件分享给任何人",
          "一个公开应用",
        ],
        cta: "免费开始",
      },
      pro: {
        name: "专业版",
        unit: "每月",
        desc: "应用数量不限，使用自己的域名，失败的部署还能自动修复。",
        rows: [
          "免费版全部功能，数量不限",
          "你自己的域名",
          "自动修复每次构建失败",
          "无 {brand} 标识",
          "备份和撤销",
        ],
        cta: "升级专业版",
      },
      team: {
        name: "团队版",
        price: "联系我们",
        unit: "",
        desc: "适合把内部工具集中管理的团队。只按构建者付费，使用者永远免费。",
        rows: [
          "专业版全部功能",
          "使用公司域名登录",
          "角色和审计日志",
          "接收者不限，始终免费",
        ],
        cta: "联系我们",
      },
    },
  },

  templatesPage: {
    metaTitle: "自行托管模板",
    metaDescription:
      "在自己的网址上运行常用开源软件。把提示词交给编程智能体，其余由它完成。",
    h1: "自行托管常用软件",
    p: "自己的网址、数据库和副本。无需点击设置向导，只要把提示词交给正在使用的编程智能体，它会在你阅读其他内容时完成部署。",
    footnote:
      "每个项目都用你账户中的源码构建。{brand} 配置所需资源，生成只需随机性的密钥，并且只询问无法自行确定的信息。",
  },

  templatePage: {
    metaTitle: "自行托管 {name}",
    h1: "自行托管 {name}",
    copyLabel: "接入你的智能体",
    copyNote:
      "粘贴到 Claude Code、Codex、Cursor 或其他能运行命令的工具中。它会克隆源码、完成部署并让你登录。无需使用控制面板。",
    provisionsHead: "{brand} 配置的资源",
    generatesHead: "为你生成的密钥",
    asksHead: "可能需要你提供的信息",
    handledHead: "同时处理",
    caveatsHead: "开始之前",
    noAsks: "无需提供任何信息。没有问题要回答。",
    noProvisions: "无需配置。此应用不需要任何资源。",
    noGenerates: "无需生成。",
    generatedSuffix: "{key}，自动生成，无需询问",
    selfUrlLine: "自己的网址，通过 {vars} 注入",
    migrationsLine: "迁移，在应用启动前运行",
    privateLine: "默认保持私有，直到你更改",
    required: "必填",
    optional: "可选",
    readInstructions: "智能体将读取的说明",
    onGithub: "GitHub 上的 {name}",
    everyCommand: "所有 {cli} 命令",
  },

  templates: {
    excalidraw: {
      blurb: "在你自己的网址上运行白板。",
      what: "用于绘制手绘图的虚拟白板。它构建为静态文件，场景保存在浏览器中，因此无需配置任何资源。",
      provisions: [] as string[],
      asks: [] as string[],
      caveats: [
        "场景保存在浏览器中，而非服务器。这是绘图工具，不是带账户的共享工作区。",
      ],
    },
    "open-webui": {
      blurb: "为自己的模型提供私有聊天界面。",
      what: "适用于本地和 API 模型的自行托管界面。对话存入 Postgres，上传文件存入磁盘，两者都由 {brand} 提供，因此无需密钥即可使用。",
      provisions: ["Postgres", "位于 /data 的持久磁盘"],
      asks: [
        "仅在连接兼容 OpenAI 的模型时需要。可以跳过，稍后连接 Ollama，或随时用 `{cli} env` 添加。",
      ],
      caveats: [
        "首个创建的账户会成为管理员。{brand} 上的应用本来就是私有的，所以该账户属于你。",
        "未配置模型提供商时，应用可以启动和运行，但暂时没有模型可对话。",
      ],
    },
    "cal-com": {
      blurb: "在自己的域名上运行自己的日程安排。",
      what: "开源日程安排工具。它需要 Postgres、几个生成的密钥、环境中的自身网址，以及在 Web 进程启动前执行迁移。{brand} 无需询问即可完成这四项。",
      provisions: ["Postgres"],
      asks: [
        "仅在连接 Google Calendar 时需要。Cal.com 无需它也能运行，只是日历集成功能会保持关闭。",
      ],
      caveats: [
        "这是 monorepo，Docker 构建时间较长。免费方案每月有 30 次构建且一次只能构建一个，因此几次失败就会占用不少额度。",
        "迁移必须在 Web 进程启动前运行。发布步骤正是为此准备，跳过后应用只能显示首页，其他功能都会失败。",
      ],
    },
  },

  copyPrompt: {
    label: "复制提示词",
    copied: "已复制。粘贴给你的智能体。",
    aria: "复制指示智能体部署此项目的提示词",
  },
};

export default zhHans;
