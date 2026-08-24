import type { Messages } from "../types";

const zhHant: Messages = {
  nav: {
    product: "產品",
    ship: "上線",
    services: "服務",
    fixes: "修正",
    agents: "代理程式",
    templates: "範本",
    pricing: "價格",
    resources: "資源",
    changelog: "更新紀錄",
    docs: "文件",
    community: "社群",
    myApps: "我的應用程式",
    homeAria: "{brand} 首頁",
  },

  hero: {
    h1: "代理式開發時代的雲端",
    p: "{brand} 執行你用程式開發代理打造的應用程式。從代理或終端機部署，就有正式網址、Postgres、Redis 與儲存空間。",
  },

  onboard: {
    label: "讓代理開始使用",
    copied: "已複製。貼給你的代理。",
    aria: "複製讓程式開發代理開始使用的提示詞",
  },

  intro: {
    h2: "每個應用程式都從這裡上線",
    p: "不必設定。每個應用程式上線時就有可分享的網址，資料庫從第一次部署起備份。此後我們持續監看，並直接說明哪裡出錯，而不只顯示錯誤代碼。",
    link: "讓代理開始使用",
  },

  worksWith: {
    line: "支援你手邊正在使用的程式開發代理",
  },

  features: {
    h2: "應用程式需要的不只一台伺服器",
    cta: "讓應用程式上線",
    ship: {
      h: "一道指令就能上線",
      p: "{brand} 建置應用程式並回傳正式網址。支援 Next、Django、Rails、Go，或任何容器應用程式。",
    },
    services: {
      h: "建置每項服務",
      p: "Postgres、Redis 與物件儲存空間會隨應用程式啟動。Worker 和 cron 在旁執行，不必自行建立。",
    },
    fixes: {
      h: "把修正方式交給代理",
      p: "{brand} 擷取正式環境錯誤，轉成程式開發代理可採取的指示。",
    },
  },

  mock: {
    files: "檔案",
    processes: "程序",
    cacheAndQueues: "快取與佇列",
    live: "正式環境",
    forYourAgent: "交給你的代理",
    diagnosis:
      "移轉從未執行，因此結構是空的。加入發布步驟，在 Web 程序啟動前執行移轉，再重新部署。",
  },

  interfaces: {
    h2: "使用 MCP 與 CLI，不用儀表板",
    cli: {
      title: "命令列",
      p: "凡是能執行指令的工具，都能操作你的基礎設施",
      pmAria: "套件管理工具",
      copyAria: "複製指令",
      copiedAria: "已複製",
    },
    commands: {
      ship: "將目前資料夾上線",
      logs: "查看正式環境實際收到的內容",
      errors: "查看目前的故障",
      diagnose: "產生代理能採用的修正方式",
      rollback: "回復到正常版本",
      env: "機密資料絕不放進程式碼",
      exec: "開啟正式應用程式的 shell",
    },
    mcp: {
      soon: "即將推出",
      p: "你的代理會把 {brand} 當成工具呼叫，不必進入 shell。無需離開目前的編輯器，就能部署、讀取紀錄並套用修正。",
      cta: "閱讀代理手冊",
    },
  },

  templatesSection: {
    h2: "自行代管常用軟體",
    all: "所有範本",
    cardCta: "自行代管",
    shotAlt: "{name} 執行畫面",
  },

  oss: {
    h2: "自行代管首 1 年免費",
    p: "我們喜愛開源，也希望任何人都能更容易執行軟體。",
    cta: "自行代管任何軟體",
  },

  closing: {
    h2: "把你的應用程式帶來這裡",
  },

  footer: {
    tagline: "代理式開發時代的雲端",
    product: "產品",
    whatYouGet: "方案內容",
    pricing: "價格",
    build: "建置",
    agentManual: "代理手冊",
    shipAnApp: "讓應用程式上線",
    signIn: "登入",
    company: "公司",
    contact: "聯絡我們",
    github: "GitHub",
    rights: "© {year} Supersonic Software, Inc.",
    languageAria: "語言",
    rss: "RSS",
  },

  pricing: {
    metaTitle: "價格",
    metaDescription: "永久免費，也沒有基礎設施帳單。",
    h1: "永久免費。沒有基礎設施帳單。",
    p: "雲端資源已包含，你不會收到 AWS 帳單。免費方案的應用程式不會休眠或到期。",
    per: "/",
    footnote:
      "選用任何方案，自行代管開源專案的第一年都免費。不必申請，部署時會自動辨識。",
    plans: {
      free: {
        name: "免費",
        unit: "永久",
        desc: "三個真正的應用程式，包含資料庫、網址，還能分享給任何人。",
        rows: [
          "3 個應用程式",
          "包含資料庫與儲存空間",
          "透過電子郵件分享給任何人",
          "一個公開應用程式",
        ],
        cta: "免費開始",
      },
      pro: {
        name: "專業版",
        unit: "每月",
        desc: "應用程式數量不限，可用自己的網域，部署失敗時也會自行修復。",
        rows: [
          "免費版全部功能，數量不限",
          "你自己的網域",
          "自動修正每次建置失敗",
          "沒有 {brand} 標章",
          "備份與復原",
        ],
        cta: "升級專業版",
      },
      team: {
        name: "團隊版",
        price: "聯絡我們",
        unit: "",
        desc: "適合把內部工具集中管理的團隊。只為建置的人付費，使用的人永遠免費。",
        rows: [
          "專業版全部功能",
          "使用公司網域登入",
          "角色與稽核紀錄",
          "接收者不限，永遠免費",
        ],
        cta: "聯絡我們",
      },
    },
  },

  templatesPage: {
    metaTitle: "自行代管範本",
    metaDescription:
      "在自己的網址執行常用開源軟體。把提示詞交給程式開發代理，其餘由它完成。",
    h1: "自行代管常用軟體",
    p: "自己的網址、資料庫與副本。不用逐步點選設定精靈，只要把提示詞交給正在使用的程式開發代理，它會在你閱讀其他內容時完成部署。",
    footnote:
      "每個專案都從你帳號中的原始碼建置。{brand} 建立所需資源，產生只需隨機內容的機密資料，只詢問無法自行判斷的資訊。",
  },

  templatePage: {
    metaTitle: "自行代管 {name}",
    h1: "自行代管 {name}",
    copyLabel: "讓代理開始使用",
    copyNote:
      "貼到 Claude Code、Codex、Cursor 或其他能執行指令的工具。它會複製原始碼、完成部署，並讓你直接登入。不用操作儀表板。",
    provisionsHead: "{brand} 建立的資源",
    generatesHead: "為你產生的機密資料",
    asksHead: "可能需要你提供的內容",
    handledHead: "一併處理",
    caveatsHead: "開始之前",
    noAsks: "不需要任何內容。沒有問題要回答。",
    noProvisions: "不建立任何資源。此應用程式不需要。",
    noGenerates: "不需要產生。",
    generatedSuffix: "{key}，自動產生，不會詢問",
    selfUrlLine: "自己的網址，透過 {vars} 注入",
    migrationsLine: "移轉，在應用程式啟動前執行",
    privateLine: "預設保持私有，直到你變更",
    required: "必填",
    optional: "選填",
    readInstructions: "代理將讀取的說明",
    onGithub: "GitHub 上的 {name}",
    everyCommand: "每一道 {cli} 指令",
  },

  templates: {
    excalidraw: {
      blurb: "在你自己的網址執行白板。",
      what: "用來繪製手繪圖的虛擬白板。它會建置成靜態檔案，場景留在瀏覽器，因此不用建立或設定任何資源。",
      provisions: [] as string[],
      asks: [] as string[],
      caveats: [
        "場景留在瀏覽器，不在伺服器。這是繪圖工具，不是附帳號的共享工作區。",
      ],
    },
    "open-webui": {
      blurb: "供自有模型使用的私人聊天介面。",
      what: "適用於本機與 API 模型的自行代管介面。對話存入 Postgres，上傳內容存進磁碟，兩者都由 {brand} 提供，因此不用金鑰即可使用。",
      provisions: ["Postgres", "位於 /data 的持久磁碟"],
      asks: [
        "只有連接 OpenAI 相容模型時需要。可以略過，之後再連到 Ollama，或隨時用 `{cli} env` 加入。",
      ],
      caveats: [
        "第一個建立的帳號會成為管理員。{brand} 上的應用程式原本就是私人的，因此該帳號屬於你。",
        "沒有設定模型供應商時，應用程式仍可啟動與執行，只是暫時沒有模型能對話。",
      ],
    },
    "cal-com": {
      blurb: "在自己的網域使用自己的排程服務。",
      what: "開源排程服務。它需要 Postgres、幾組產生的機密資料、環境中的自身網址，以及在 Web 程序啟動前執行移轉。{brand} 不必詢問就能完成這四項。",
      provisions: ["Postgres"],
      asks: [
        "只有連接 Google Calendar 時需要。Cal.com 沒有它仍可執行，只是行事曆整合功能會關閉。",
      ],
      caveats: [
        "這是 monorepo，Docker 建置時間較長。免費方案每月有 30 次建置且一次只能執行一個，因此幾次失敗就會耗掉不少額度。",
        "移轉必須在 Web 程序啟動前執行。發布步驟就是為此而設，略過後應用程式只會顯示首頁，其他功能都會失敗。",
      ],
    },
  },

  copyPrompt: {
    label: "複製提示詞",
    copied: "已複製。貼給你的代理。",
    aria: "複製指示代理部署此項目的提示詞",
  },
};

export default zhHant;
