import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { parse } from "@babel/parser";
import { describe, expect, it } from "vitest";
import { SRC_ROOT } from "../test/sourceFiles";

function runtimeDependencies(file: string): string[] {
  const ast = parse(readFileSync(file, "utf8"), {
    sourceType: "module",
    plugins: ["typescript", "jsx"],
  });
  return ast.program.body.flatMap((statement) => {
    if (
      statement.type === "ImportDeclaration" &&
      statement.importKind !== "type"
    ) {
      return statement.specifiers.length === 0 ||
        statement.specifiers.some(
          (specifier) =>
            specifier.type !== "ImportSpecifier" ||
            specifier.importKind !== "type",
        )
        ? [statement.source.value]
        : [];
    }
    if (
      (statement.type === "ExportNamedDeclaration" ||
        statement.type === "ExportAllDeclaration") &&
      statement.source &&
      statement.exportKind !== "type"
    )
      return [statement.source.value];
    return [];
  });
}

function runtimeGraph(entry: string): string[] {
  const seen = new Set<string>();
  const visit = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const spec of runtimeDependencies(file)) {
      if (!spec.startsWith(".")) continue;
      const target = resolve(dirname(file), spec);
      const resolved = [
        target,
        `${target}.ts`,
        `${target}.tsx`,
        join(target, "index.ts"),
        join(target, "index.tsx"),
      ].find((candidate) => /\.tsx?$/.test(candidate) && existsSync(candidate));
      if (resolved) visit(resolved);
    }
  };
  visit(join(SRC_ROOT, entry));
  return [...seen].map((file) =>
    relative(SRC_ROOT, file).replaceAll("\\", "/"),
  );
}

describe("production shell views", () => {
  it.each(["layout/MobileShellView.tsx", "layout/StudioShellView.tsx"])(
    "%s has no runtime store, command, API or connected shell dependency",
    (entry) => {
      const graph = runtimeGraph(entry);
      expect(graph).toContain("ui/BottomSheet.tsx");
      expect(graph).toContain("ui/ToggleButton.tsx");
      expect(
        graph.filter(
          (file) =>
            /^(state|commands|api|extensions)\//.test(file) ||
            /(^|\/)(MobileShell|StudioShell|TransportBar|Inspector|TranscriptPanel|TrackHeadersColumn)\.tsx$/.test(
              file,
            ) ||
            /\.stories\.tsx?$/.test(file),
        ),
      ).toEqual([]);
    },
  );
});

it("the production fader view owns range interaction without runtime adapters", () => {
  const graph = runtimeGraph("tracks/TrackFaderView.tsx");
  expect(graph).toContain("hooks/useCommitRange.ts");
  expect(graph).toContain("ui/Button.tsx");
  expect(
    graph.filter(
      (file) =>
        /^(state|commands|api|extensions)\//.test(file) ||
        /(^|\/)TrackFader\.tsx$/.test(file) ||
        /\.stories\.tsx?$/.test(file),
    ),
  ).toEqual([]);
});

it("the production mix view reaches both controls without runtime adapters", () => {
  const graph = runtimeGraph("tracks/TrackMixView.tsx");
  expect(graph).toContain("tracks/TrackFaderView.tsx");
  expect(graph).toContain("tracks/TrackMuteSoloButtonsView.tsx");
  expect(graph).toContain("hooks/useCommitRange.ts");
  expect(
    graph.filter(
      (file) =>
        /^(state|commands|api|extensions)\//.test(file) ||
        /(^|\/)(TrackMix|TrackFader|TrackMuteSoloButtons)\.tsx$/.test(file) ||
        /\.stories\.tsx?$/.test(file),
    ),
  ).toEqual([]);
});
