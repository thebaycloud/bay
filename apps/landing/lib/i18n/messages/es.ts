import type { Messages } from "../types";

const es: Messages = {
  nav: {
    product: "Producto",
    ship: "Publicar",
    services: "Servicios",
    fixes: "Correcciones",
    agents: "Agentes",
    templates: "Plantillas",
    pricing: "Precios",
    resources: "Recursos",
    changelog: "Novedades",
    docs: "Documentación",
    community: "Comunidad",
    myApps: "Mis apps",
    homeAria: "Inicio de {brand}",
  },

  hero: {
    h1: "La nube para la era de agentes",
    p: "{brand} ejecuta las apps que creas con agentes de código. Despliega desde tu agente o terminal y recibe una URL activa, Postgres, Redis y almacenamiento.",
  },

  onboard: {
    label: "Conecta tu agente",
    copied: "Copiado. Pégalo en tu agente.",
    aria: "Copiar el prompt que conecta tu agente de código",
  },

  intro: {
    h2: "Todas las apps se publican desde aquí",
    p: "No hay nada que configurar. Cada app se publica con una dirección para compartir y copias de seguridad de la base de datos desde el primer despliegue. Después la vigilamos y explicamos qué falló con palabras claras, no con un código de error.",
    link: "Conecta tu agente",
  },

  worksWith: {
    line: "Funciona con el agente de código que ya usas",
  },

  features: {
    h2: "Tu app necesita más que un servidor",
    cta: "Publica tu app",
    ship: {
      h: "Publica con un solo comando",
      p: "{brand} compila la app y devuelve una URL activa. Next, Django, Rails, Go o cualquier app en un contenedor.",
    },
    services: {
      h: "Crea todos los servicios",
      p: "Postgres, Redis y el almacenamiento de objetos arrancan con tu app. Los workers y cron corren a su lado. No configuras nada.",
    },
    fixes: {
      h: "Entrega correcciones a tu agente",
      p: "{brand} detecta errores en producción y los convierte en instrucciones para tu agente de código.",
    },
  },

  mock: {
    files: "Archivos",
    processes: "Procesos",
    cacheAndQueues: "caché y colas",
    live: "Producción",
    forYourAgent: "Para tu agente",
    diagnosis:
      "Las migraciones no se ejecutaron y el esquema está vacío. Agrega un paso de publicación que las ejecute antes del proceso web y vuelve a desplegar.",
  },

  interfaces: {
    h2: "MCP y CLI en lugar de un panel",
    cli: {
      title: "Línea de comandos",
      p: "Todo lo que ejecute un comando puede operar tu infraestructura",
      pmAria: "Gestor de paquetes",
      copyAria: "Copiar comando",
      copiedAria: "Copiado",
    },
    commands: {
      ship: "publica la carpeta actual",
      logs: "lo que producción recibió",
      errors: "lo que está fallando ahora",
      diagnose: "una corrección que tu agente puede aplicar",
      rollback: "vuelve a una versión funcional",
      env: "secretos, nunca en el código",
      exec: "un shell en la app activa",
    },
    mcp: {
      soon: "Próximamente",
      p: "Tu agente llama a {brand} como herramientas en vez de abrir un shell. Despliega, lee registros y aplica correcciones sin salir del editor.",
      cta: "Lee el manual del agente",
    },
  },

  templatesSection: {
    h2: "Aloja algo que ya usas",
    all: "Todas las plantillas",
    cardCta: "Alójalo tú mismo",
    shotAlt: "{name} en ejecución",
  },

  oss: {
    h2: "Alojamiento propio gratis por 1 año",
    p: "Nos gusta el código abierto y queremos que cualquiera pueda ejecutar software con mayor facilidad.",
    cta: "Aloja cualquier software",
  },

  closing: {
    h2: "Trae tu app aquí",
  },

  footer: {
    tagline: "La nube para la era de agentes",
    product: "Producto",
    whatYouGet: "Qué incluye",
    pricing: "Precios",
    build: "Crear",
    agentManual: "Manual del agente",
    docs: "Documentación",
    shipAnApp: "Publicar una app",
    signIn: "Iniciar sesión",
    company: "Empresa",
    about: "Quiénes somos",
    contact: "Contacto",
    github: "GitHub",
    privacy: "Privacidad",
    rights: "© {year} Supersonic Software, Inc.",
    languageAria: "Idioma",
    rss: "RSS",
  },

  pricing: {
    metaTitle: "Precios",
    metaDescription: "Gratis para siempre, sin factura de infraestructura.",
    h1: "Gratis para siempre. Sin factura de infraestructura.",
    p: "Tu nube está incluida y nunca recibes una factura de AWS. Las apps del plan gratuito no se suspenden ni vencen.",
    per: "/",
    footnote:
      "El primer año de un proyecto de código abierto con alojamiento propio es gratis con cualquier plan. No debes solicitarlo: se detecta al desplegar.",
    plans: {
      free: {
        name: "Gratis",
        unit: "para siempre",
        desc: "Tres apps reales con base de datos, dirección y todas las personas con quienes las compartas.",
        rows: [
          "3 apps",
          "Base de datos y almacenamiento incluidos",
          "Comparte con cualquiera por email",
          "Una app pública",
        ],
        cta: "Comienza gratis",
      },
      pro: {
        name: "Profesional",
        unit: "al mes",
        desc: "Apps ilimitadas, un dominio propio y despliegues fallidos que se reparan solos.",
        rows: [
          "Todo lo de Gratis, sin límites",
          "Tu propio dominio",
          "Corrección automática de cada compilación fallida",
          "Sin distintivo de {brand}",
          "Respaldos y deshacer",
        ],
        cta: "Obtén Profesional",
      },
      team: {
        name: "Equipo",
        price: "Hablemos",
        unit: "",
        desc: "Para equipos con todas sus herramientas internas en un lugar. Pagas por quienes crean, nunca por quienes usan.",
        rows: [
          "Todo lo de Profesional",
          "Acceso con el dominio de tu empresa",
          "Roles y registro de auditoría",
          "Destinatarios ilimitados y siempre gratis",
        ],
        cta: "Habla con nosotros",
      },
    },
  },

  templatesPage: {
    metaTitle: "Plantillas de alojamiento propio",
    metaDescription:
      "Código abierto que ya usas, en una dirección propia. Da el prompt a tu agente de código y él hace el resto.",
    h1: "Aloja algo que ya usas",
    p: "Tu dirección, tu base de datos, tu copia. No recorres un asistente: das un prompt al agente de código que ya usas y él despliega mientras haces otra cosa.",
    footnote:
      "Cada proyecto se compila desde su código fuente en tu cuenta. {brand} crea lo necesario, genera los secretos que solo requieren entropía y solo pregunta lo que no puede deducir.",
  },

  templatePage: {
    metaTitle: "Aloja {name}",
    h1: "Aloja {name}",
    copyLabel: "Conecta tu agente",
    copyNote:
      "Pégalo en Claude Code, Codex, Cursor o cualquier herramienta que ejecute comandos. Clona el código, lo despliega e inicia tu sesión. No hay un paso en el panel.",
    provisionsHead: "Lo que {brand} configura",
    generatesHead: "Secretos que genera para ti",
    asksHead: "Lo que puede pedirte",
    handledHead: "También incluido",
    caveatsHead: "Antes de comenzar",
    noAsks: "Nada. No hay preguntas que responder.",
    noProvisions: "Nada. Esta app no necesita nada.",
    noGenerates: "No se necesita ninguno.",
    generatedSuffix: "{key}, generado en vez de solicitado",
    selfUrlLine: "Su propia dirección, insertada como {vars}",
    migrationsLine: "Migraciones antes de iniciar la app",
    privateLine: "Privada hasta que indiques lo contrario",
    required: "obligatorio",
    optional: "opcional",
    readInstructions: "Las instrucciones que leerá tu agente",
    onGithub: "{name} en GitHub",
    everyCommand: "Todos los comandos de {cli}",
  },

  templates: {
    excalidraw: {
      blurb: "La pizarra en una dirección propia.",
      what: "Una pizarra virtual para diagramas dibujados a mano. Se compila en archivos estáticos y guarda las escenas en el navegador, así que no hay nada que configurar.",
      provisions: [] as string[],
      asks: [] as string[],
      caveats: [
        "Las escenas viven en el navegador, no en el servidor. Es una herramienta de dibujo, no un espacio compartido con cuentas.",
      ],
    },
    "open-webui": {
      blurb: "Una interfaz de chat privada para tus modelos.",
      what: "Una interfaz propia para modelos locales y de API. Guarda conversaciones en Postgres y archivos en disco. {brand} proporciona ambos, así que funciona sin claves.",
      provisions: ["Postgres", "Un disco persistente en /data"],
      asks: [
        "Solo si quieres usar modelos compatibles con OpenAI. Omítelo y conéctalo a Ollama después, o agrégalo cuando quieras con `{cli} env`.",
      ],
      caveats: [
        "La primera cuenta creada será administradora. En {brand} la app ya es privada, así que esa cuenta es tuya.",
        "Sin proveedor de modelos, inicia y funciona, pero aún no tiene un modelo con el cual conversar.",
      ],
    },
    "cal-com": {
      blurb: "Tu agenda en tu propio dominio.",
      what: "Agenda de código abierto. Requiere Postgres, algunos secretos generados, su dirección en el entorno y migraciones antes del proceso web. {brand} resuelve los cuatro sin preguntarte.",
      provisions: ["Postgres"],
      asks: [
        "Solo si quieres conectar Google Calendar. Cal.com funciona sin él; solo quedan desactivadas las integraciones de calendario.",
      ],
      caveats: [
        "Es un monorepo y la compilación de Docker tarda. El plan gratuito permite 30 compilaciones al mes, una a la vez, así que varios intentos fallidos consumen una parte importante.",
        "Las migraciones deben ejecutarse antes del proceso web. Para eso sirve el paso de publicación; sin él, la página inicial abre pero todo lo demás falla.",
      ],
    },
  },

  copyPrompt: {
    label: "Copiar el prompt",
    copied: "Copiado. Pégalo en tu agente.",
    aria: "Copiar el prompt que indica a tu agente cómo desplegar esto",
  },
};

export default es;
