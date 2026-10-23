import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { uploadPaperFile } from "../../src/api";

let requests: UploadRequest[];

class UploadRequest {
  status = 201;
  responseText = JSON.stringify({ paperId: "paper-1", size: 4, cloudStored: false });
  upload: { onprogress?: (event: ProgressEvent) => void } = {};
  onload?: () => void;
  onerror?: () => void;
  open = vi.fn();
  setRequestHeader = vi.fn();
  send = vi.fn((_body: Blob) => this.onload?.());

  constructor() { requests.push(this); }
}

beforeEach(() => {
  requests = [];
  vi.stubGlobal("XMLHttpRequest", UploadRequest);
});

afterEach(() => { vi.unstubAllGlobals(); });

describe("PDF upload metadata", () => {
  it.each(["paper.pdf", "长期记忆 研究.pdf"])("sends the encoded original filename: %s", async (name) => {
    const file = new File(["%PDF"], name, { type: "application/pdf" });
    await uploadPaperFile("paper-1", file);

    expect(requests[0].open).toHaveBeenCalledWith("PUT", "/api/papers/paper-1/file");
    expect(requests[0].setRequestHeader).toHaveBeenCalledWith("x-file-name", encodeURIComponent(name));
    expect(requests[0].send).toHaveBeenCalledWith(file);
  });

  it("accepts an unnamed Blob without sending a filename header", async () => {
    const blob = new Blob(["%PDF"], { type: "application/pdf" });
    await uploadPaperFile("paper-1", blob);

    expect(requests[0].setRequestHeader).not.toHaveBeenCalledWith("x-file-name", expect.anything());
    expect(requests[0].send).toHaveBeenCalledWith(blob);
  });

  it("preserves the server's local-only storage result", async () => {
    const result = await uploadPaperFile("paper-1", new Blob(["%PDF"], { type: "application/pdf" }));
    expect(result).toEqual({ paperId: "paper-1", size: 4, cloudStored: false });
  });
});
