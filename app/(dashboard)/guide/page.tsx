import Section from "@/components/ui/section";
import GuideTasks from "@/components/domain/guide-tasks";
import PageHeader from "@/components/ui/page-header";
import { getT, type TFn } from "@/lib/i18n";

export const dynamic = "force-dynamic";

function FlowDiagram({ t }: { t: TFn }) {
  const box = { fill: "var(--surface-sunken)", stroke: "var(--border-strong)" } as const;
  const nodes = [
    {
      x: 8,
      label: t("guide.flow.source.label"),
      label2: t("guide.flow.source.detail"),
      sub: t("guide.flow.source.sub"),
    },
    {
      x: 178,
      label: t("guide.flow.sync.label"),
      label2: t("guide.flow.sync.detail"),
      sub: t("guide.flow.sync.sub"),
    },
    {
      x: 348,
      label: t("guide.flow.db.label"),
      label2: t("guide.flow.db.detail"),
      sub: t("guide.flow.db.sub"),
    },
    {
      x: 518,
      label: t("guide.flow.web.label"),
      label2: t("guide.flow.web.detail"),
      sub: t("guide.flow.web.sub"),
    },
    {
      x: 688,
      label: t("guide.flow.evaluate.label"),
      label2: t("guide.flow.evaluate.detail"),
      sub: t("guide.flow.evaluate.sub"),
    },
    {
      x: 858,
      label: t("guide.flow.alert.label"),
      label2: t("guide.flow.alert.detail"),
      sub: t("guide.flow.alert.sub"),
    },
  ];

  return (
    <div className="guide-diagram-scroll">
      <svg
        viewBox="0 0 1030 96"
        className="guide-diagram guide-flow-diagram"
        role="img"
        aria-label={t("guide.flow.aria")}
      >
        {nodes.map((node, index) => (
          <g key={node.x}>
            <rect x={node.x} y={16} width={144} height={56} rx={9} {...box} strokeWidth={1} />
            <circle cx={node.x + 16} cy={32} r={8} fill="var(--accent)" />
            <text
              x={node.x + 16}
              y={35.5}
              textAnchor="middle"
              fontSize={9.5}
              fontWeight={700}
              fill="#fff"
              fontFamily="var(--font-mono)"
            >
              {index + 1}
            </text>
            <text
              x={node.x + 32}
              y={36}
              fontSize={11}
              fontWeight={600}
              fill="var(--text)"
              fontFamily="var(--font-display)"
            >
              {node.label}
            </text>
            <text
              x={node.x + 32}
              y={49}
              fontSize={11}
              fontWeight={600}
              fill="var(--text)"
              fontFamily="var(--font-display)"
            >
              {node.label2}
            </text>
            <text
              x={node.x + 32}
              y={63}
              fontSize={9}
              fill="var(--text-muted)"
              fontFamily="var(--font-mono)"
            >
              {node.sub}
            </text>
            {index < nodes.length - 1 && (
              <path
                d={`M ${node.x + 148} 44 h 22`}
                stroke="var(--accent)"
                strokeWidth={1.6}
                markerEnd="url(#guide-flow-arrow)"
                fill="none"
              />
            )}
          </g>
        ))}
        <defs>
          <marker id="guide-flow-arrow" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
            <path d="M0,0 L7,3.5 L0,7 Z" fill="var(--accent)" />
          </marker>
        </defs>
        <text
          x={1012}
          y={30}
          textAnchor="end"
          fontSize={10}
          fontWeight={600}
          fill="var(--st-normal-fg)"
          fontFamily="var(--font-mono)"
        >
          {t("guide.flow.destination.chat")}
        </text>
        <text
          x={1012}
          y={48}
          textAnchor="end"
          fontSize={10}
          fontWeight={600}
          fill="var(--text-muted)"
          fontFamily="var(--font-mono)"
        >
          {t("guide.flow.destination.email")}
        </text>
        <text
          x={1012}
          y={66}
          textAnchor="end"
          fontSize={10}
          fontWeight={600}
          fill="var(--text-muted)"
          fontFamily="var(--font-mono)"
        >
          {t("guide.flow.destination.webhook")}
        </text>
      </svg>
    </div>
  );
}

function ResolverDiagram({ t }: { t: TFn }) {
  const layer = (y: number, width: number, label: string, sub: string, strong = false) => (
    <g key={label}>
      <rect
        x={(560 - width) / 2}
        y={y}
        width={width}
        height={40}
        rx={8}
        fill={strong ? "var(--accent-soft)" : "var(--surface-sunken)"}
        stroke={strong ? "var(--accent)" : "var(--border-strong)"}
        strokeWidth={1}
      />
      <text
        x={280}
        y={y + 17}
        textAnchor="middle"
        fontSize={11}
        fontWeight={600}
        fill="var(--text)"
        fontFamily="var(--font-display)"
      >
        {label}
      </text>
      <text
        x={280}
        y={y + 31}
        textAnchor="middle"
        fontSize={9}
        fill="var(--text-muted)"
        fontFamily="var(--font-mono)"
      >
        {sub}
      </text>
    </g>
  );

  return (
    <div className="guide-diagram-scroll">
      <svg
        viewBox="0 0 900 240"
        className="guide-diagram guide-resolver-diagram"
        role="img"
        aria-label={t("guide.resolver.aria")}
      >
        <text
          x={280}
          y={14}
          textAnchor="middle"
          fontSize={10}
          fontWeight={700}
          fill="var(--text-muted)"
          fontFamily="var(--font-mono)"
          letterSpacing={1}
        >
          {t("guide.resolver.order")}
        </text>
        {layer(24, 520, t("guide.resolver.global.label"), t("guide.resolver.global.sub"))}
        {layer(76, 440, t("guide.resolver.warehouse.label"), t("guide.resolver.warehouse.sub"))}
        {layer(128, 360, t("guide.resolver.zone.label"), t("guide.resolver.zone.sub"))}
        {layer(180, 280, t("guide.resolver.storage.label"), t("guide.resolver.storage.sub"), true)}
        {[64, 116, 168].map((y) => (
          <path
            key={y}
            d={`M 280 ${y} v 10`}
            stroke="var(--accent)"
            strokeWidth={1.6}
            markerEnd="url(#guide-resolver-arrow)"
            fill="none"
          />
        ))}
        <defs>
          <marker id="guide-resolver-arrow" markerWidth="7" markerHeight="7" refX="3.5" refY="6" orient="0">
            <path d="M0,0 L7,0 L3.5,7 Z" fill="var(--accent)" />
          </marker>
        </defs>
        <rect
          x={620}
          y={54}
          width={250}
          height={128}
          rx={9}
          fill="var(--surface-sunken)"
          stroke="var(--border-strong)"
          strokeWidth={1}
        />
        <text
          x={745}
          y={76}
          textAnchor="middle"
          fontSize={11}
          fontWeight={600}
          fill="var(--text)"
          fontFamily="var(--font-display)"
        >
          {t("guide.resolver.category")}
        </text>
        <text
          x={745}
          y={94}
          textAnchor="middle"
          fontSize={9.5}
          fill="var(--text-muted)"
          fontFamily="var(--font-mono)"
        >
          {t("guide.resolver.categoryRule")}
        </text>
        <text x={636} y={118} fontSize={10} fill="var(--st-normal-fg)" fontFamily="var(--font-mono)">
          {t("guide.resolver.included")}
        </text>
        <text x={636} y={138} fontSize={10} fill="var(--st-critical-fg)" fontFamily="var(--font-mono)">
          {t("guide.resolver.excluded")}
        </text>
        <text x={636} y={158} fontSize={10} fill="var(--text-muted)" fontFamily="var(--font-mono)">
          {t("guide.resolver.available")}
        </text>
        <text x={636} y={174} fontSize={10} fill="var(--text-muted)" fontFamily="var(--font-mono)">
          {t("guide.resolver.unavailable")}
        </text>
        <text
          x={280}
          y={236}
          textAnchor="middle"
          fontSize={9.5}
          fill="var(--text-muted)"
          fontFamily="var(--font-mono)"
        >
          {t("guide.resolver.masterNote")}
        </text>
      </svg>
    </div>
  );
}

export default async function GuidePage() {
  const t = await getT();
  const roles = [
    [t("guide.role.viewer"), "view", t("guide.role.viewer.description")],
    [t("guide.role.supervisor"), "spv", t("guide.role.supervisor.description")],
    [t("guide.role.admin"), "admin", t("guide.role.admin.description")],
  ];

  return (
    <div className="dashboard-page">
      <PageHeader
        eyebrow={t("guide.header.eyebrow")}
        title={t("guide.header.title")}
        description={t("guide.header.description")}
      />

      <Section eyebrow={t("guide.tasks.eyebrow")} title={t("guide.tasks.title")}>
        <GuideTasks />
      </Section>

      <Section eyebrow={t("guide.section.overview.eyebrow")} title={t("guide.section.overview.title")}>
        <FlowDiagram t={t} />
        <div className="mt-3 grid gap-3 md:grid-cols-3">
          {roles.map(([role, code, description]) => (
            <div key={code} className="card card-pad text-[12px]">
              <div className="flex items-center justify-between">
                <span className="font-semibold">{role}</span>
                <span className="chip num">{code}</span>
              </div>
              <p className="mt-1" style={{ color: "var(--text-muted)" }}>{description}</p>
            </div>
          ))}
        </div>
      </Section>

      <Section eyebrow={t("guide.section.dashboard.eyebrow")} title={t("guide.section.dashboard.title")}>
        <div className="grid gap-3 md:grid-cols-2">
          <div className="card card-pad text-[12.5px] leading-relaxed">
            <span className="panel-title block pb-1">{t("guide.dashboard.status.title")}</span>
            <p style={{ color: "var(--text-muted)" }}>
              {t("guide.dashboard.status.intro")}{" "}
              <b style={{ color: "var(--st-normal-fg)" }}>{t("status.NORMAL")}</b> &lt; 70% ·{" "}
              <b style={{ color: "var(--st-monitor-fg)" }}>{t("status.MONITOR")}</b> 70–79% ·{" "}
              <b style={{ color: "var(--st-warning-fg)" }}>{t("status.WARNING")}</b> 80–89% ·{" "}
              <b style={{ color: "var(--st-critical-fg)" }}>{t("status.CRITICAL")}</b> 90–99% ·{" "}
              <b>{t("status.BREACH")}</b> ≥ 100%. {t("guide.dashboard.status.tail")}
            </p>
          </div>
          <div className="card card-pad text-[12.5px] leading-relaxed">
            <span className="panel-title block pb-1">{t("guide.dashboard.basis.title")}</span>
            <p style={{ color: "var(--text-muted)" }}>{t("guide.dashboard.basis.body")}</p>
          </div>
          <div className="card card-pad text-[12.5px] leading-relaxed">
            <span className="panel-title block pb-1">{t("guide.dashboard.heatmap.title")}</span>
            <p style={{ color: "var(--text-muted)" }}>{t("guide.dashboard.heatmap.body")}</p>
          </div>
          <div className="card card-pad text-[12.5px] leading-relaxed">
            <span className="panel-title block pb-1">{t("guide.dashboard.search.title")}</span>
            <p style={{ color: "var(--text-muted)" }}>{t("guide.dashboard.search.body")}</p>
          </div>
        </div>
      </Section>

      <Section eyebrow={t("guide.section.alert.eyebrow")} title={t("guide.section.alert.title")}>
        <div className="card card-pad text-[12.5px] leading-relaxed" style={{ color: "var(--text-muted)" }}>
          {t("guide.section.alert.body")}
        </div>
      </Section>

      <Section eyebrow={t("guide.section.settings.eyebrow")} title={t("guide.section.settings.title")}>
        <ResolverDiagram t={t} />
        <div className="mt-3 grid gap-3 md:grid-cols-2">
          <div className="card card-pad text-[12.5px] leading-relaxed">
            <span className="panel-title block pb-1">{t("guide.webhook.title")}</span>
            <ol className="list-decimal space-y-1 pl-4" style={{ color: "var(--text-muted)" }}>
              <li>{t("guide.webhook.step1")}</li>
              <li>{t("guide.webhook.step2")}</li>
              <li>{t("guide.webhook.step3")}</li>
              <li>{t("guide.webhook.step4")}</li>
              <li>{t("guide.webhook.step5")}</li>
            </ol>
          </div>
          <div className="card card-pad text-[12.5px] leading-relaxed">
            <span className="panel-title block pb-1">{t("guide.recipients.title")}</span>
            <p style={{ color: "var(--text-muted)" }}>{t("guide.recipients.body")}</p>
          </div>
        </div>
      </Section>

    </div>
  );
}
