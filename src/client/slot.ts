interface DsHReact {
  createElement(tag: string, props: Record<string, unknown> | null, ...children: unknown[]): unknown;
}

interface DsHSlotContext {
  slots: {
    inject(slot: string, factory: () => unknown): void;
    register(descriptor: Record<string, unknown>, component: (props: { size?: number }) => unknown): unknown;
  };
}

interface DsHModuleLoader {
  load(definition: {
    id: string;
    factory(require: (name: string) => unknown): {
      inject: readonly string[];
      apply(ctx: DsHSlotContext): void;
    };
  }): void;
}

declare const window: Window & { __ModuleLoader__: DsHModuleLoader };

window.__ModuleLoader__.load({
  id: "@zhizhang/dsh-workbench",
  factory(require) {
    const React = require("react") as DsHReact;

    function Workbench() {
      const source = new URL("api/zhizhang/workbench", document.baseURI);
      return React.createElement("iframe", {
        title: "织章工作台",
        src: source.href,
        style: { width: "100%", height: "100%", minHeight: "68vh", border: 0, display: "block" },
      });
    }

    function PanelIcon({ size }: { size?: number }) {
      return React.createElement(
        "span",
        { "aria-hidden": true, style: { fontSize: size, lineHeight: 1 } },
        "织",
      );
    }

    return {
      inject: ["slots"],
      apply(ctx) {
        ctx.slots.inject("main", () =>
          ctx.slots.register({ name: "main", key: "zhizhang.workbench" }, Workbench),
        );
        ctx.slots.inject("sidebar.panellist", () =>
          ctx.slots.register(
            { name: "sidebar.panellist", id: "zhizhang.workbench", label: "织章", order: 20 },
            PanelIcon,
          ),
        );
        ctx.slots.inject("conversation.view", () =>
          ctx.slots.register(
            { name: "conversation.view", id: "zhizhang.workbench", label: "织章", order: 40 },
            Workbench,
          ),
        );
      },
    };
  },
});

export {};
