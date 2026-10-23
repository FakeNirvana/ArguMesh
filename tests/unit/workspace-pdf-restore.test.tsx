import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../../src/api";
import { LibraryPage } from "../../src/pages/LibraryPage";
import { useWorkspace, WorkspaceProvider, type LocalPaper } from "../../src/state/workspace";

vi.mock("../../src/pdf/document", () => ({ inspectPdf: vi.fn(), sha256File: vi.fn() }));

const project: api.RemoteProject = {
  id: "persisted-project", name: "持久化项目", description: "", extractionProgress: 0,
  createdAt: "2026-10-23T00:00:00.000Z", archived: false, archivedAt: null,
  sortOrder: 0, paperCount: 1, workspacePath: null,
};

const storedPaper: api.RemotePaper = {
  id: "persisted-paper", title: "已导入文献", shortName: "", authors: "作者", venue: "本地 PDF", year: 2026,
  abstract: null, doi: null, arxivId: null, sourceUrl: null, fileHash: null,
  hasFile: true, mimeType: "application/pdf", fileSize: 2 * 1024 * 1024,
  createdAt: "2026-10-23T00:00:00.000Z", readingStatus: "精读", favorite: false, tags: [],
  fileName: null, pageCount: null, outline: [], archived: false, archivedAt: null,
};

describe("WorkspaceProvider PDF restore", () => {
  let root: Root | null = null;
  let host: HTMLDivElement;
  let restoredPaper: LocalPaper | undefined;

  function Harness() {
    restoredPaper = useWorkspace().papers.find((paper) => paper.id === storedPaper.id);
    return null;
  }

  async function openLibrary(paper: api.RemotePaper = storedPaper) {
    vi.mocked(api.listPapersByProject).mockResolvedValue({ papers: [paper] });
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(<MemoryRouter initialEntries={[`/projects/${project.id}/library`]} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <WorkspaceProvider>
          <Harness />
          <Routes>
            <Route path="/projects/:projectId/library" element={<LibraryPage />} />
            <Route path="/projects/:projectId/library/:paperId/read" element={<div>阅读器已打开</div>} />
          </Routes>
        </WorkspaceProvider>
      </MemoryRouter>);
    });
  }

  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    restoredPaper = undefined;
    vi.spyOn(api, "listProjects").mockResolvedValue({ projects: [project] });
    vi.spyOn(api, "listPapersByProject").mockResolvedValue({ papers: [] });
    vi.spyOn(api, "listMatrices").mockResolvedValue({ matrices: [] });
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(async () => {
    if (root) await act(async () => root!.unmount());
    root = null;
    vi.restoreAllMocks();
    document.body.innerHTML = "";
    window.localStorage.clear();
  });

  it("restores the reading action without browser metadata when the API still has the PDF", async () => {
    expect(window.localStorage.length).toBe(0);
    await openLibrary();

    const readButton = [...host.querySelectorAll("button")].find((button) => button.textContent === "阅读");
    expect(readButton).toBeDefined();
    expect(host.querySelector(".upload-link")?.textContent).toBe("更换");
    expect(restoredPaper?.fileName).toBe(`${storedPaper.id}.pdf`);
    expect(restoredPaper?.fileSize).toBe(storedPaper.fileSize);

    await act(async () => readButton!.click());
    expect(host.textContent).toContain("阅读器已打开");
  });

  it.each(["server", "browser"] as const)("preserves the original filename from %s metadata", async (source) => {
    const originalName = "LongMemEval.pdf";
    if (source === "browser") {
      window.localStorage.setItem("paperidea_workspace_v2_local", JSON.stringify({ papers: [{
        id: storedPaper.id, title: storedPaper.title, authors: "", venue: "", year: 2026,
        status: "精读", tags: [], projectIds: [project.id], fileName: originalName, fileSize: 1,
      }] }));
    }
    await openLibrary({ ...storedPaper, fileName: source === "server" ? originalName : null });

    expect(restoredPaper?.fileName).toBe(originalName);
    expect(restoredPaper?.fileSize).toBe(storedPaper.fileSize);
    expect(host.querySelector(".paper-title-cell em")?.textContent).toContain(originalName);
    expect(host.querySelector(".upload-link")?.textContent).toBe("更换");
  });

  it("keeps the upload action for papers without a stored PDF", async () => {
    await openLibrary({ ...storedPaper, hasFile: false, mimeType: null, fileSize: null });

    expect(restoredPaper?.fileName).toBeUndefined();
    expect([...host.querySelectorAll("button")].some((button) => button.textContent === "阅读")).toBe(false);
    expect(host.querySelector(".upload-link")?.textContent).toBe("上传 PDF");
  });
});
