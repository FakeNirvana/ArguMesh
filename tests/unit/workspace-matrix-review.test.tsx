import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import * as api from "../../src/api";
import { useWorkspace, WorkspaceProvider, type LocalMatrixCell } from "../../src/state/workspace";

it("本地批量确认一次持久化，并重新检查当前状态而保留内容与其他矩阵", async () => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  window.localStorage.clear();
  vi.spyOn(api, "listProjects").mockRejectedValue(new Error("Offline"));
  const source: LocalMatrixCell = { status: "draft", locked: false, value: "结论", claim: "人工核验的结论", sourcePage: "第 3 页", sourceSection: "Results", sourceExcerpt: "原文摘录", confidence: .8 };
  const cells = { "dim:paper": source, "dim:locked": { ...source, locked: true }, "dim:conflict": { ...source, status: "conflict" as const }, "dim:missing": { ...source, sourceExcerpt: "" } };
  const matrix = { id: "local-matrix", projectId: "project", name: "Local", description: "", dimensions: [{ id: "dim", label: "Method" }], paperIds: ["paper", "locked", "conflict", "missing"], cells, source: "local", createdAt: "" };
  window.localStorage.setItem("paperidea_workspace_v2_local", JSON.stringify({ matrices: [matrix, { ...matrix, id: "other-matrix" }] }));
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  let current: ReturnType<typeof useWorkspace>;
  function Harness() { current = useWorkspace(); return null; }
  try {
    await act(async () => root.render(<WorkspaceProvider><Harness /></WorkspaceProvider>));
    await act(async () => current!.confirmMatrixCells("local-matrix", Object.keys(cells)));
    expect(current!.matrices[0].cells["dim:paper"]).toEqual({ ...source, status: "confirmed", locked: true });
    expect(current!.matrices[0].cells["dim:locked"]).toEqual(cells["dim:locked"]);
    expect(current!.matrices[0].cells["dim:conflict"]).toEqual(cells["dim:conflict"]);
    expect(current!.matrices[0].cells["dim:missing"]).toEqual(cells["dim:missing"]);
    expect(current!.matrices[1].cells).toEqual(cells);
    expect(JSON.parse(window.localStorage.getItem("paperidea_workspace_v2_local")!).matrices[0].cells["dim:paper"].locked).toBe(true);
  } finally {
    await act(async () => root.unmount()); document.body.innerHTML = ""; window.localStorage.clear(); vi.restoreAllMocks();
  }
});
