import type { JsonResume } from "./resume-parse";

export interface ResumeArtifactCalibrationCase {
  id: string;
  locale: "en" | "zh";
  lengthBudget: "one_page" | "two_page";
  expectedPages: 1 | 2;
  officeTextSentinels: readonly string[];
  resume: JsonResume;
}

const EN_ONE_PAGE: JsonResume = {
  basics: {
    name: "Avery Lin",
    label: "Product Engineer",
    email: "avery@example.test",
    phone: "+65 6000 0001",
    summary:
      "Product engineer with eight years of explicitly documented experience building workflow software, developer platforms, and measurable reliability improvements across distributed teams.",
    location: { city: "Singapore", countryCode: "SG" },
    profiles: [
      { network: "Portfolio", url: "https://avery.example.test" },
      { network: "GitHub", url: "https://github.example.test/avery" },
    ],
  },
  work: [
    {
      name: "Northstar Systems",
      position: "Senior Product Engineer",
      startDate: "2022-03",
      endDate: "Present",
      highlights: [
        "Led delivery of a configurable operations workspace used by 14 internal teams, reducing weekly manual reconciliation from six hours to ninety minutes.",
        "Introduced contract tests and staged releases for four services, cutting customer-facing regressions from nine per quarter to two.",
        "Partnered with design and support to turn 120 interview notes into a prioritized roadmap and ship the top three workflow gaps.",
      ],
    },
    {
      name: "Harbor Cloud",
      position: "Software Engineer",
      startDate: "2018-06",
      endDate: "2022-02",
      highlights: [
        "Built TypeScript and Python services that processed 2.4 million audited events each day with a documented 99.95% availability target.",
        "Reworked onboarding around progressive validation, improving first-week activation from 61% to 78% in the measured cohort.",
        "Created incident playbooks and telemetry dashboards that reduced median diagnosis time from forty minutes to fourteen.",
      ],
    },
  ],
  skills: [
    { name: "Languages", keywords: ["TypeScript", "Python", "SQL"] },
    { name: "Platforms", keywords: ["PostgreSQL", "Redis", "Docker"] },
    { name: "Practice", keywords: ["Product discovery", "Observability", "Accessibility"] },
  ],
  projects: [
    {
      name: "Release Evidence Ledger",
      description:
        "Open reference implementation for attaching test evidence and approvals to immutable release records.",
      highlights: ["Documented adoption by three volunteer-maintained projects."],
    },
  ],
  education: [
    {
      institution: "Example Institute of Technology",
      area: "Computer Science",
      studyType: "BSc",
      startDate: "2014",
      endDate: "2018",
    },
  ],
};

const EN_TWO_PAGE: JsonResume = {
  basics: {
    name: "Jordan Rivera",
    label: "Staff Platform Engineer",
    email: "jordan@example.test",
    phone: "+1 555 010 0200",
    summary:
      "Staff platform engineer with twelve years of documented experience designing internal platforms, migrating critical services, and coaching product teams through reliability and security programs. Work spans regulated data, high-volume event processing, developer experience, and pragmatic technical leadership.",
    location: { city: "Austin", region: "TX", countryCode: "US" },
    profiles: [
      { network: "Portfolio", url: "https://jordan.example.test" },
      { network: "GitHub", url: "https://github.example.test/jordan" },
    ],
  },
  work: [
    {
      name: "Atlas Payments",
      position: "Staff Platform Engineer",
      startDate: "2022-01",
      endDate: "Present",
      summary:
        "Technical lead for the paved-road platform used by payments, risk, and customer operations teams.",
      highlights: [
        "Designed a tenant-aware deployment control plane adopted by 32 services, reducing median production lead time from four days to forty-five minutes.",
        "Led a twelve-month migration from shared credentials to workload identity, documenting the removal of 1,800 long-lived secrets and every rollback decision.",
        "Defined service-level objectives with seven product teams and connected error-budget policy to release automation, lowering severe incidents by 38%.",
        "Created a capacity model for peak settlement traffic and validated it through quarterly game days at twice the recorded seasonal maximum.",
        "Coached six senior engineers through architecture reviews, written decision records, and cross-team incident leadership rotations.",
      ],
    },
    {
      name: "Cedar Health Systems",
      position: "Senior Software Engineer",
      startDate: "2018-04",
      endDate: "2021-12",
      summary:
        "Built compliant data and workflow services for clinical operations without storing provider portal credentials.",
      highlights: [
        "Split a monolithic scheduling service into five independently deployable domains while maintaining a measured 99.97% availability level.",
        "Implemented immutable access logs and retention controls that passed two external audits without high-severity findings.",
        "Replaced synchronous exports with resumable background jobs, increasing successful completion for large customers from 72% to 98%.",
        "Introduced schema compatibility checks for 24 producers and consumers, preventing six documented breaking changes before production.",
        "Facilitated weekly failure reviews that turned recurring timeout and retry patterns into shared platform libraries.",
      ],
    },
    {
      name: "Willow Analytics",
      position: "Software Engineer",
      startDate: "2015-07",
      endDate: "2018-03",
      highlights: [
        "Developed Python ingestion services for customer event streams and traced source records through every normalization step.",
        "Optimized PostgreSQL queries and partitioning for a reporting workload that grew from 40 million to 310 million rows.",
        "Built self-service replay tools with dry-run previews and approval checkpoints, reducing support escalations by 46%.",
        "Added data-quality assertions for missing identifiers, invalid timestamps, and duplicate events across nine connectors.",
      ],
    },
    {
      name: "Orchard Software",
      position: "Junior Software Engineer",
      startDate: "2013-05",
      endDate: "2015-06",
      highlights: [
        "Maintained customer-facing workflow modules in JavaScript and SQL with paired review for every production change.",
        "Automated a manual release checklist and recorded a reduction from ninety minutes to twenty minutes per release.",
        "Wrote diagnostic guides from resolved support cases and reduced repeat escalation volume in the following two quarters.",
      ],
    },
  ],
  skills: [
    { name: "Languages", keywords: ["TypeScript", "Python", "Go", "SQL"] },
    {
      name: "Infrastructure",
      keywords: ["PostgreSQL", "Redis", "Kafka", "Kubernetes", "Terraform"],
    },
    {
      name: "Reliability",
      keywords: ["SLOs", "Incident command", "Capacity planning", "Observability"],
    },
    {
      name: "Security",
      keywords: ["Workload identity", "Audit logging", "Threat modeling"],
    },
    {
      name: "Leadership",
      keywords: ["Architecture review", "Mentoring", "Roadmap facilitation"],
    },
  ],
  projects: [
    {
      name: "Portable Failure Lab",
      description:
        "A local test harness for replaying recorded dependency failures against service adapters without production access.",
      highlights: [
        "Published twelve deterministic scenarios covering rate limits, partial writes, malformed responses, and delayed callbacks.",
        "Used by two community teams to reproduce incidents before proposing fixes.",
      ],
    },
    {
      name: "Schema Change Field Guide",
      description:
        "A maintained guide and example repository for expand-and-contract database changes across mixed deployment versions.",
      highlights: [
        "Includes tested PostgreSQL examples, rollback notes, and review checklists.",
        "Referenced in four internal migration plans recorded by the example organizations.",
      ],
    },
  ],
  education: [
    {
      institution: "Example State University",
      area: "Software Engineering",
      studyType: "BS",
      startDate: "2009",
      endDate: "2013",
    },
  ],
  languages: [
    { language: "English", fluency: "Native" },
    { language: "Spanish", fluency: "Professional" },
  ],
  certificates: [
    { name: "Example Cloud Security Professional", date: "2023" },
  ],
};

const ZH_ONE_PAGE: JsonResume = {
  basics: {
    name: "林安然",
    label: "产品工程师",
    email: "anran@example.test",
    phone: "+86 10 6000 0001",
    summary:
      "拥有八年明确项目记录的产品工程师，专注企业协作、数据平台与可靠性交付，能够把用户研究、工程实现和可衡量的业务结果连接起来。",
    location: { city: "上海", countryCode: "CN" },
    profiles: [{ network: "作品集", url: "https://anran.example.test" }],
  },
  work: [
    {
      name: "北辰科技",
      position: "高级产品工程师",
      startDate: "2022-03",
      endDate: "Present",
      highlights: [
        "主导可配置运营工作台交付，覆盖十四个内部团队，将每周人工核对时间从六小时缩短到九十分钟。",
        "为四个服务引入契约测试和分阶段发布，使客户可见回归问题从每季度九个下降到两个。",
        "与设计和支持团队整理一百二十份访谈记录，形成优先级路线图并交付前三项流程缺口。",
      ],
    },
    {
      name: "海港云",
      position: "软件工程师",
      startDate: "2018-06",
      endDate: "2022-02",
      highlights: [
        "构建 TypeScript 与 Python 服务，每日处理二百四十万条可审计事件，并达到记录中的 99.95% 可用性目标。",
        "重构渐进式校验引导流程，使统计样本中的首周激活率从 61% 提升到 78%。",
        "建立事故手册和遥测看板，将故障定位时间中位数从四十分钟降低到十四分钟。",
      ],
    },
  ],
  skills: [
    { name: "语言", keywords: ["TypeScript", "Python", "SQL"] },
    { name: "平台", keywords: ["PostgreSQL", "Redis", "Docker"] },
    { name: "方法", keywords: ["产品发现", "可观测性", "无障碍设计"] },
  ],
  projects: [
    {
      name: "发布证据账本",
      description: "把测试证据和人工批准绑定到不可变发布记录的开源参考实现。",
      highlights: ["已有三个志愿者维护项目记录采用情况。"],
    },
  ],
  education: [
    {
      institution: "示例理工大学",
      area: "计算机科学",
      studyType: "本科",
      startDate: "2014",
      endDate: "2018",
    },
  ],
};

const ZH_TWO_PAGE: JsonResume = {
  basics: {
    name: "周景明",
    label: "资深平台工程师",
    email: "jingming@example.test",
    phone: "+86 21 6000 0200",
    summary:
      "拥有十二年明确工作记录的平台工程师，负责内部开发平台、关键服务迁移和可靠性治理，覆盖受监管数据、高吞吐事件处理、开发者体验与跨团队技术领导。",
    location: { city: "深圳", countryCode: "CN" },
    profiles: [
      { network: "作品集", url: "https://jingming.example.test" },
      { network: "代码主页", url: "https://code.example.test/jingming" },
    ],
  },
  work: [
    {
      name: "星图支付",
      position: "资深平台工程师",
      startDate: "2022-01",
      endDate: "Present",
      summary: "负责支付、风控和客户运营团队共同使用的标准交付平台。",
      highlights: [
        "设计多租户部署控制面并由三十二个服务采用，将生产交付时间中位数从四天缩短到四十五分钟。",
        "带领十二个月的工作负载身份迁移，记录移除一千八百个长期凭据的过程和每一次回滚决策。",
        "与七个产品团队建立服务目标并把错误预算连接到发布自动化，使严重事故数量下降 38%。",
        "建立高峰结算容量模型，通过季度演练验证两倍于已记录季节峰值的负载。",
        "通过架构评审、决策记录和事故指挥轮值辅导六名高级工程师。",
      ],
    },
    {
      name: "青杉健康",
      position: "高级软件工程师",
      startDate: "2018-04",
      endDate: "2021-12",
      summary: "在不保存第三方平台账号凭据的前提下构建合规数据和业务流程服务。",
      highlights: [
        "将单体排班服务拆分为五个可独立部署的领域，并保持记录中的 99.97% 可用性水平。",
        "实现不可变访问日志和保留策略，两次外部审计均未发现高严重级问题。",
        "把同步导出改为可恢复后台任务，大客户成功完成率从 72% 提高到 98%。",
        "为二十四个生产者和消费者引入兼容性检查，在上线前阻止六次已记录的破坏性变更。",
        "主持每周故障复盘，把重复出现的超时和重试模式沉淀为共享平台库。",
      ],
    },
    {
      name: "柳岸数据",
      position: "软件工程师",
      startDate: "2015-07",
      endDate: "2018-03",
      highlights: [
        "开发 Python 数据接入服务，并让每一条标准化记录都能追溯到原始事件。",
        "优化 PostgreSQL 查询和分区，使报表系统从四千万行增长到三亿一千万行。",
        "构建带预演和审批闸门的自助重放工具，使支持升级请求减少 46%。",
        "为九个连接器增加缺失标识、无效时间戳和重复事件的数据质量断言。",
      ],
    },
    {
      name: "果园软件",
      position: "初级软件工程师",
      startDate: "2013-05",
      endDate: "2015-06",
      highlights: [
        "维护 JavaScript 与 SQL 客户流程模块，所有生产变更均保留结对评审记录。",
        "自动化人工发布清单，使单次发布时间从九十分钟降低到二十分钟。",
        "根据已解决支持案例编写诊断指南，随后两个季度的重复升级数量持续下降。",
      ],
    },
  ],
  skills: [
    { name: "语言", keywords: ["TypeScript", "Python", "Go", "SQL"] },
    {
      name: "基础设施",
      keywords: ["PostgreSQL", "Redis", "Kafka", "Kubernetes", "Terraform"],
    },
    { name: "可靠性", keywords: ["服务目标", "事故指挥", "容量规划", "可观测性"] },
    { name: "安全", keywords: ["工作负载身份", "审计日志", "威胁建模"] },
    { name: "领导力", keywords: ["架构评审", "工程辅导", "路线图协作"] },
  ],
  projects: [
    {
      name: "可移植故障实验室",
      description: "在无需生产访问权限的环境中，对服务适配器重放依赖故障的本地测试工具。",
      highlights: [
        "发布十二个确定性场景，覆盖限流、部分写入、异常响应和延迟回调。",
        "两个社区团队记录使用这些场景复现事故后再提交修复方案。",
      ],
    },
    {
      name: "数据库变更手册",
      description: "面向混合部署版本的扩展—收缩迁移示例库和持续维护指南。",
      highlights: [
        "包含经过测试的 PostgreSQL 示例、回滚说明和评审清单。",
        "示例组织记录的四份内部迁移计划引用了该手册。",
      ],
    },
    {
      name: "多环境发布验证器",
      description:
        "在合并前验证配置、权限和数据库变更能否在开发、预发布与生产环境保持一致的命令行工具。",
      highlights: [
        "为十二类配置差异提供可复现检查，并把失败证据写入不可变构建记录。",
        "通过只读预演展示预计资源变更，必须获得明确批准后才允许继续发布。",
        "在三个示例服务中记录发现七次环境漂移，并在进入生产前完成修正。",
        "发布操作手册，覆盖回滚、部分失败和依赖服务暂时不可用的处理路径。",
      ],
    },
  ],
  education: [
    {
      institution: "示例大学",
      area: "软件工程",
      studyType: "本科",
      startDate: "2009",
      endDate: "2013",
    },
  ],
  languages: [
    { language: "中文", fluency: "母语" },
    { language: "英文", fluency: "工作沟通" },
  ],
  certificates: [
    { name: "示例云安全专业认证", date: "2023" },
    { name: "示例 Kubernetes 管理认证", date: "2022" },
    { name: "示例 PostgreSQL 性能认证", date: "2021" },
  ],
  awards: [
    {
      name: "可靠性交付奖",
      summary: "因跨团队服务目标和演练机制在示例组织年度评审中获得记录。",
    },
    {
      name: "工程辅导奖",
      summary: "因持续维护架构评审和事故指挥轮值机制在示例组织获得记录。",
    },
  ],
};

export const RESUME_ARTIFACT_CALIBRATION_CASES: readonly ResumeArtifactCalibrationCase[] =
  [
    {
      id: "en-one-page",
      locale: "en",
      lengthBudget: "one_page",
      expectedPages: 1,
      officeTextSentinels: [
        "Avery Lin",
        "Northstar Systems",
        "Example Institute of Technology",
      ],
      resume: EN_ONE_PAGE,
    },
    {
      id: "en-two-page",
      locale: "en",
      lengthBudget: "two_page",
      expectedPages: 2,
      officeTextSentinels: [
        "Jordan Rivera",
        "Orchard Software",
        "Example Cloud Security Professional",
      ],
      resume: EN_TWO_PAGE,
    },
    {
      id: "zh-one-page",
      locale: "zh",
      lengthBudget: "one_page",
      expectedPages: 1,
      officeTextSentinels: ["林安然", "海港云", "示例理工大学"],
      resume: ZH_ONE_PAGE,
    },
    {
      id: "zh-two-page",
      locale: "zh",
      lengthBudget: "two_page",
      expectedPages: 2,
      officeTextSentinels: ["周景明", "果园软件", "可靠性交付奖"],
      resume: ZH_TWO_PAGE,
    },
  ];
