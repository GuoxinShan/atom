import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_PROJECT_LABELS,
  DEFAULT_THEME_LABELS,
  DEFAULT_THEME_VOCABULARY,
  TAG_OTHER,
  collectTagLabels,
  divertProjectFromText,
  divertThemeFromText,
  loadThemeVocabulary,
  mapToAllowlist,
  tryMapAllowlist,
} from "./theme-vocabulary.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const tmpDirs: string[] = [];

after(() => {
  for (const d of tmpDirs) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

describe("theme vocabulary allowlist", () => {
  it("loads the in-repo Chinese vocabulary", () => {
    const vocab = loadThemeVocabulary(repoRoot);
    const themes = vocab.themes.map((l) => l.title);
    assert.equal(vocab.other, "其他");
    for (const title of [
      "AI推进",
      "日程/会议",
      "云之家",
      "发布与发布流程",
      "产品缺陷",
      "迁移方案",
      "能力缺口",
      "文档",
      "其他",
    ]) {
      assert.equal(themes.includes(title), true, `missing theme ${title}`);
    }
    assert.equal(
      themes.some((t) => !/[\u3400-\u9fff]/.test(t)),
      false,
      `non-Chinese theme titles: ${themes.filter((t) => !/[\u3400-\u9fff]/.test(t)).join(",")}`
    );
    assert.ok(themes.length <= 12);
    assert.equal(vocab.projects.some((p) => p.title === "事元"), true);
  });

  it("accepts allowlist titles and maps known slugs", () => {
    assert.equal(tryMapAllowlist("AI推进", DEFAULT_THEME_LABELS), "AI推进");
    assert.equal(tryMapAllowlist("「迁移方案」", DEFAULT_THEME_LABELS), "迁移方案");
    assert.equal(tryMapAllowlist("能力缺口", DEFAULT_THEME_LABELS), "能力缺口");
    assert.equal(tryMapAllowlist("ai-advance", DEFAULT_THEME_LABELS), "AI推进");
    assert.equal(tryMapAllowlist("Schedule Mcp", DEFAULT_THEME_LABELS), "日程/会议");
    assert.equal(tryMapAllowlist("日历", DEFAULT_THEME_LABELS), "日程/会议");
    assert.equal(tryMapAllowlist("release-process", DEFAULT_THEME_LABELS), "发布与发布流程");
    assert.equal(tryMapAllowlist("product-bug", DEFAULT_THEME_LABELS), "产品缺陷");
    assert.equal(tryMapAllowlist("ATOM", DEFAULT_PROJECT_LABELS), "事元");
  });

  it("diverts title/body onto the closed vocabulary without new labels", () => {
    assert.equal(divertThemeFromText("速记迁入灵基鉴权", "评估速记迁入灵基"), "速记");
    assert.equal(
      divertThemeFromText("评估速记迁入灵基并重做lingee壳鉴权", "lingee 鉴权"),
      "速记"
    );
    assert.equal(divertThemeFromText("修复日程 MCP 云之家授权失败", ""), "日程/会议");
    assert.equal(divertThemeFromText("Schedule Mcp 授权失败", "AI推进里的日程 MCP"), "日程/会议");
    assert.equal(divertThemeFromText("Desk OAuth leftover", "need login"), undefined);
    assert.equal(divertProjectFromText("需要给 ATOM Desk 加上空状态文案", ""), "事元");
  });

  it("does not add vocabulary entries when diverting 其他", () => {
    const titles = DEFAULT_THEME_VOCABULARY.themes.map((l) => l.title).sort();
    assert.deepEqual(
      titles,
      ["AI推进", "云之家", "其他", "发布与发布流程", "产品缺陷", "文档", "日程/会议", "能力缺口", "迁移方案", "速记"].sort()
    );
    assert.equal(tryMapAllowlist("OAuth", DEFAULT_THEME_LABELS), undefined);
    assert.equal(tryMapAllowlist("Task Ui", DEFAULT_THEME_LABELS), undefined);
  });

  it("maps unknown or empty values to 其他", () => {
    assert.equal(tryMapAllowlist("cand_zzzzzz", DEFAULT_THEME_LABELS), undefined);
    assert.equal(tryMapAllowlist("https://example.com/x", DEFAULT_THEME_LABELS), undefined);
    assert.equal(tryMapAllowlist("OAuth", DEFAULT_THEME_LABELS), undefined);
    assert.equal(tryMapAllowlist("foo-bar-baz", DEFAULT_THEME_LABELS), undefined);
    assert.equal(tryMapAllowlist("none", DEFAULT_THEME_LABELS), undefined);
    assert.equal(tryMapAllowlist("", DEFAULT_THEME_LABELS), undefined);
    assert.equal(mapToAllowlist("oauth-desk", DEFAULT_THEME_LABELS), TAG_OTHER);
    assert.equal(mapToAllowlist(undefined, DEFAULT_THEME_LABELS), TAG_OTHER);
  });

  it("does not harvest free-form workspace or existing titles", () => {
    const titles = collectTagLabels({ repoRoot }).map((l) => l.title);
    assert.equal(titles.includes("AI推进"), true);
    assert.equal(titles.includes("OAuth"), false);
    assert.equal(titles.includes("mcpApp开发群"), false);
    assert.equal(titles.includes("release-process"), false);
    assert.deepEqual(titles, DEFAULT_THEME_VOCABULARY.themes.map((l) => l.title));
  });

  it("lets product edit data/theme-vocabulary.json without code changes", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atom-vocab-"));
    tmpDirs.push(dir);
    fs.mkdirSync(path.join(dir, "data"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "data/theme-vocabulary.json"),
      JSON.stringify({
        version: 1,
        other: "其他",
        themes: [
          { title: "自定义主题", aliases: ["custom-theme"] },
          { title: "其他" },
        ],
        projects: [{ title: "其他" }],
      })
    );
    const vocab = loadThemeVocabulary(dir);
    assert.equal(tryMapAllowlist("custom-theme", vocab.themes), "自定义主题");
    assert.equal(mapToAllowlist("unknown-slug", vocab.themes, vocab.other), "其他");
    assert.equal(
      vocab.themes.some((t) => t.title === "发布与发布流程"),
      false
    );
  });
});
