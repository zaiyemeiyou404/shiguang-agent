import { useCallback, useEffect, useMemo, useState } from "react";

import { requireDesktopBridge } from "../../bridge";
import type { DesktopApproval, DesktopMemory, DesktopMemoryCandidate, DesktopProviderConnectionResult, DesktopSessionLlmSettings, DesktopSettings, ToolApprovalMode } from "../../bridge";
import { SignalPill, ToolBtn } from "../../components/ui-primitives";
import { MemoryPanel } from "../workbench/MemoryPanel";
import { copyTextToClipboard } from "../../utils/clipboard";
import {
  CODEX_PROVIDER_HINT,
  PROVIDER_PRESETS,
  buildProviderSettings,
  buildSessionLlmSettings,
  buildSettings,
  createProviderDraft,
  findProviderPreset,
  formatMcpServersJson,
  formatSettingsValue,
  modelOptionsForProvider,
  normalizeProviderDraftForCompare,
  parseMcpServersJson,
  providerCatalogFromSettings,
  providerDraftFromSettings,
  providerLabel,
  providerTone,
  sameDisplayPath,
  summarizeApiKeySource,
  toolApprovalModeLabel,
  uniqueProviderKey,
  type ProviderAuthMode,
  type ProviderDraft,
  type ProviderModelOption,
  type ProviderProtocol,
} from "./provider-model";
export type SettingsDrawerMode = "full" | "model";

export function SettingsDrawer({
  open,
  onClose,
  settings,
  onSaved,
  mode = "full",
  activeSessionId,
  currentSessionWorkspaceRoot,
  currentSessionLlm,
  onSessionWorkspaceChanged,
  onSessionLlmChanged,
}: {
  open: boolean;
  onClose: () => void;
  settings: DesktopSettings | null;
  onSaved: (settings: DesktopSettings) => void;
  mode?: SettingsDrawerMode;
  activeSessionId?: string | null;
  currentSessionWorkspaceRoot?: string | null;
  currentSessionLlm?: DesktopSessionLlmSettings | null;
  onSessionWorkspaceChanged?: () => void | Promise<void>;
  onSessionLlmChanged?: () => void | Promise<void>;
}) {
  const [workspaceRoot, setWorkspaceRoot] = useState("");
  const [activeProvider, setActiveProvider] = useState("openai");
  const [activeModel, setActiveModel] = useState("");
  const [maxTokens, setMaxTokens] = useState("");
  const [toolApprovalMode, setToolApprovalMode] = useState<ToolApprovalMode>("ask");
  const [executionPreset, setExecutionPreset] = useState<DesktopSettings["executionPreset"]>("workspace_write_network");
  const [mcpServersJson, setMcpServersJson] = useState("{}");
  const [providerCatalog, setProviderCatalog] = useState<Record<string, ProviderDraft>>({ openai: createProviderDraft("openai") });
  const [providerKeyInput, setProviderKeyInput] = useState("openai");
  const [providerJsonInput, setProviderJsonInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveState, setSaveState] = useState("");
  const [showApiKey, setShowApiKey] = useState(false);
  const [testingConnection, setTestingConnection] = useState(false);
  const [connectionResult, setConnectionResult] = useState<DesktopProviderConnectionResult | null>(null);
  const [reusableApprovals, setReusableApprovals] = useState<DesktopApproval[]>([]);
  const [approvalScopeBusy, setApprovalScopeBusy] = useState<string | null>(null);
  const [approvalScopeError, setApprovalScopeError] = useState("");
  const [workspaceMemories, setWorkspaceMemories] = useState<DesktopMemory[]>([]);
  const [memoryCandidates, setMemoryCandidates] = useState<DesktopMemoryCandidate[]>([]);
  const [memoryBusy, setMemoryBusy] = useState<string | null>(null);
  const [memoryError, setMemoryError] = useState("");

  const providerOptions = useMemo(() => Object.keys(providerCatalog), [providerCatalog]);
  const providerDraft = providerCatalog[activeProvider] ?? createProviderDraft(activeProvider);
  const fullMode = mode === "full";

  useEffect(() => {
    if (!settings || !open) return;
    const catalog = providerCatalogFromSettings(settings);
    const providerKeys = Object.keys(catalog);
    const preferredProvider = fullMode ? settings.llm.provider : (currentSessionLlm?.provider ?? settings.llm.provider);
    const providerKey = catalog[preferredProvider] ? preferredProvider : (providerKeys[0] ?? "openai");
    setWorkspaceRoot(settings.workspaceRoot ?? "");
    setActiveProvider(providerKey);
    setActiveModel((fullMode ? settings.llm.model : currentSessionLlm?.model) ?? settings.llm.model ?? catalog[providerKey]?.model ?? "");
    const effectiveMaxTokens = fullMode ? settings.llm.maxTokens : currentSessionLlm?.maxTokens;
    setMaxTokens(effectiveMaxTokens
      ? String(effectiveMaxTokens)
      : settings.llm.maxTokens
        ? String(settings.llm.maxTokens)
        : catalog[providerKey]?.maxTokens
        ? String(catalog[providerKey]?.maxTokens)
        : "");
    setToolApprovalMode(settings.toolApprovalMode ?? "ask");
    setExecutionPreset(settings.executionPreset ?? "workspace_write_network");
    setMcpServersJson(formatMcpServersJson(settings.mcpServers));
    setProviderCatalog(catalog);
    setProviderKeyInput(providerKey);
    setProviderJsonInput("");
    setSaveState("");
    setConnectionResult(null);
    setShowApiKey(false);
  }, [currentSessionLlm, fullMode, settings, open]);

  const refreshReusableApprovals = useCallback(async () => {
    if (!open || !activeSessionId) {
      setReusableApprovals([]);
      return;
    }
    try {
      setApprovalScopeError("");
      setReusableApprovals(await requireDesktopBridge().listReusableApprovals(activeSessionId));
    } catch (error) {
      setApprovalScopeError(error instanceof Error ? error.message : "无法读取已记住的授权。");
    }
  }, [activeSessionId, open]);

  useEffect(() => { void refreshReusableApprovals(); }, [refreshReusableApprovals]);

  const refreshWorkspaceMemories = useCallback(async () => {
    if (!open || !activeSessionId) {
      setWorkspaceMemories([]);
      return;
    }
    try {
      setMemoryError("");
      setWorkspaceMemories(await requireDesktopBridge().listWorkspaceMemories(activeSessionId));
    } catch (error) {
      setMemoryError(error instanceof Error ? error.message : "无法读取工作区记忆。");
    }
  }, [activeSessionId, open]);

  useEffect(() => { void refreshWorkspaceMemories(); }, [refreshWorkspaceMemories]);

  const refreshMemoryCandidates = useCallback(async () => {
    if (!open || !activeSessionId) {
      setMemoryCandidates([]);
      return;
    }
    try {
      setMemoryError("");
      setMemoryCandidates(await requireDesktopBridge().listMemoryCandidates(activeSessionId));
    } catch (error) {
      setMemoryError(error instanceof Error ? error.message : "无法读取记忆建议。");
    }
  }, [activeSessionId, open]);

  useEffect(() => { void refreshMemoryCandidates(); }, [refreshMemoryCandidates]);

  const forgetWorkspaceMemory = async (memoryId: string) => {
    if (!activeSessionId) return;
    try {
      setMemoryBusy(memoryId);
      setMemoryError("");
      await requireDesktopBridge().forgetWorkspaceMemory(activeSessionId, memoryId);
      await refreshWorkspaceMemories();
    } catch (error) {
      setMemoryError(error instanceof Error ? error.message : "删除记忆失败。");
    } finally {
      setMemoryBusy(null);
    }
  };

  const markWorkspaceMemoryStale = async (memoryId: string) => {
    if (!activeSessionId) return;
    try {
      setMemoryBusy(memoryId);
      setMemoryError("");
      await requireDesktopBridge().markWorkspaceMemoryStale(activeSessionId, memoryId);
      await refreshWorkspaceMemories();
    } catch (error) {
      setMemoryError(error instanceof Error ? error.message : "标记失效失败。");
    } finally {
      setMemoryBusy(null);
    }
  };

  const decideMemoryCandidate = async (candidateId: string, decision: "accept" | "dismiss") => {
    if (!activeSessionId) return;
    try {
      setMemoryBusy(candidateId);
      setMemoryError("");
      if (decision === "accept") await requireDesktopBridge().acceptMemoryCandidate(activeSessionId, candidateId);
      else await requireDesktopBridge().dismissMemoryCandidate(activeSessionId, candidateId);
      await Promise.all([refreshMemoryCandidates(), refreshWorkspaceMemories()]);
    } catch (error) {
      setMemoryError(error instanceof Error ? error.message : "更新记忆建议失败。");
    } finally {
      setMemoryBusy(null);
    }
  };

  const revokeReusableApproval = async (approvalId: string) => {
    try {
      setApprovalScopeBusy(approvalId);
      setApprovalScopeError("");
      await requireDesktopBridge().revokeApprovalScope(approvalId);
      await refreshReusableApprovals();
    } catch (error) {
      setApprovalScopeError(error instanceof Error ? error.message : "撤销授权失败。");
    } finally {
      setApprovalScopeBusy(null);
    }
  };

  if (!open || !settings) return null;

  const patchActiveProvider = (updater: (draft: ProviderDraft) => ProviderDraft) => {
    setProviderCatalog((prev) => ({
      ...prev,
      [activeProvider]: updater(prev[activeProvider] ?? createProviderDraft(activeProvider)),
    }));
  };

  const syncProviderSelection = (nextKey: string, nextDraft?: ProviderDraft) => {
    const draft = nextDraft ?? providerCatalog[nextKey] ?? createProviderDraft(nextKey);
    setActiveProvider(nextKey);
    setProviderKeyInput(nextKey);
    setActiveModel(draft.model || settings.llm.model || "");
    setMaxTokens(draft.maxTokens || (settings.llm.provider === nextKey && settings.llm.maxTokens ? String(settings.llm.maxTokens) : ""));
    setConnectionResult(null);
    setShowApiKey(false);
  };

  const switchProvider = (nextKey: string) => {
    syncProviderSelection(nextKey);
  };

  const renameActiveProvider = () => {
    const nextKey = providerKeyInput.trim();
    if (!nextKey) {
      setProviderKeyInput(activeProvider);
      setSaveState("provider 标识不能为空。");
      return;
    }
    if (nextKey === activeProvider) {
      patchActiveProvider((prev) => ({ ...prev, key: nextKey }));
      return;
    }
    if (providerCatalog[nextKey]) {
      setProviderKeyInput(activeProvider);
      setSaveState(`provider 标识 ${nextKey} 已存在。`);
      return;
    }
    const draft = { ...(providerCatalog[activeProvider] ?? createProviderDraft(activeProvider)), key: nextKey };
    setProviderCatalog((prev) => {
      const next = { ...prev };
      delete next[activeProvider];
      next[nextKey] = draft;
      return next;
    });
    setActiveProvider(nextKey);
    setProviderKeyInput(nextKey);
    setConnectionResult(null);
    setSaveState(`已将 provider ${activeProvider} 重命名为 ${nextKey}，保存后写入配置。`);
  };

  const reorderProviders = (orderedKeys: string[]) => {
    setProviderCatalog((prev) => Object.fromEntries(orderedKeys.map((key) => [key, prev[key] ?? createProviderDraft(key)])));
  };

  const moveProvider = (direction: -1 | 1) => {
    const index = providerOptions.indexOf(activeProvider);
    const nextIndex = index + direction;
    if (index < 0 || nextIndex < 0 || nextIndex >= providerOptions.length) return;
    const orderedKeys = [...providerOptions];
    const [moved] = orderedKeys.splice(index, 1);
    orderedKeys.splice(nextIndex, 0, moved);
    reorderProviders(orderedKeys);
    setSaveState(`已调整 ${activeProvider} 的顺序，保存后写入配置。`);
  };

  const setSelectedAsRuntimeProvider = () => {
    setActiveModel(providerDraft.model || activeModel);
    setMaxTokens(providerDraft.maxTokens || maxTokens);
    setSaveState(`已将运行 Provider 切到 ${activeProvider}，保存后生效。`);
  };

  const resetToPreset = () => {
    const preset = findProviderPreset(activeProvider);
    if (!preset) {
      setSaveState(`当前 provider ${activeProvider} 没有内置预设可恢复。`);
      return;
    }
    const nextDraft = {
      ...preset,
      key: activeProvider,
      apiKey: "",
      apiKeyMasked: providerDraft.apiKeyMasked,
      hasStoredApiKey: providerDraft.hasStoredApiKey,
    };
    setProviderCatalog((prev) => ({ ...prev, [activeProvider]: nextDraft }));
    setActiveModel(preset.model);
    setMaxTokens(preset.maxTokens);
    setConnectionResult(null);
    setSaveState(`已将 ${activeProvider} 恢复到内置预设。`);
  };

  const exportProviderJson = async () => {
    const payload = JSON.stringify({
      activeProvider,
      runtime: {
        workspaceRoot,
        model: activeModel,
        maxTokens,
        toolApprovalMode,
        executionPreset,
      },
      provider: normalizeProviderDraftForCompare(providerDraft),
    }, null, 2);
    setProviderJsonInput(payload);
    try {
      await copyTextToClipboard(payload);
      setSaveState(`已导出 ${activeProvider} 配置 JSON，并复制到剪贴板。`);
    } catch {
      setSaveState(`已导出 ${activeProvider} 配置 JSON。当前环境不支持自动复制，可手动复制下方文本。`);
    }
  };

  const importProviderJson = () => {
    try {
      const parsed = JSON.parse(providerJsonInput) as {
        activeProvider?: string;
        runtime?: { workspaceRoot?: string; model?: string; maxTokens?: string | number; toolApprovalMode?: ToolApprovalMode };
        provider?: Partial<ProviderDraft>;
      };
      const targetKey = (parsed.activeProvider ?? parsed.provider?.key ?? activeProvider).trim();
      if (!targetKey) throw new Error("缺少 activeProvider / provider.key");
      const existing = providerCatalog[targetKey] ?? createProviderDraft(targetKey);
      const nextDraft: ProviderDraft = {
        ...existing,
        ...parsed.provider,
        key: targetKey,
        apiKey: typeof parsed.provider?.apiKey === "string" ? parsed.provider.apiKey : existing.apiKey,
        apiKeyMasked: typeof parsed.provider?.apiKeyMasked === "string" ? parsed.provider.apiKeyMasked : existing.apiKeyMasked,
        hasStoredApiKey: typeof parsed.provider?.hasStoredApiKey === "boolean" ? parsed.provider.hasStoredApiKey : existing.hasStoredApiKey,
        apiKeyEnv: typeof parsed.provider?.apiKeyEnv === "string" ? parsed.provider.apiKeyEnv : existing.apiKeyEnv,
        model: typeof parsed.provider?.model === "string" ? parsed.provider.model : existing.model,
        maxTokens: parsed.provider?.maxTokens !== undefined ? String(parsed.provider.maxTokens) : existing.maxTokens,
      };
      setProviderCatalog((prev) => ({ ...prev, [targetKey]: nextDraft }));
      syncProviderSelection(targetKey, nextDraft);
      if (typeof parsed.runtime?.workspaceRoot === "string") setWorkspaceRoot(parsed.runtime.workspaceRoot);
      if (typeof parsed.runtime?.model === "string") setActiveModel(parsed.runtime.model);
      if (parsed.runtime?.maxTokens !== undefined) setMaxTokens(String(parsed.runtime.maxTokens));
      if (parsed.runtime?.toolApprovalMode === "ask" || parsed.runtime?.toolApprovalMode === "workspace_edits") {
        setToolApprovalMode(parsed.runtime.toolApprovalMode);
      }
      setSaveState(`已导入 ${targetKey} 配置 JSON，保存后写入配置文件。`);
    } catch (error) {
      setSaveState(error instanceof Error ? `导入失败：${error.message}` : `导入失败：${String(error)}`);
    }
  };

  const addProvider = () => {
    const nextKey = uniqueProviderKey(providerOptions, "provider");
    const nextDraft = createProviderDraft(nextKey);
    setProviderCatalog((prev) => ({ ...prev, [nextKey]: nextDraft }));
    syncProviderSelection(nextKey, nextDraft);
    setSaveState("已创建新的 provider 草稿，填完后保存即可写入配置。");
  };

  const duplicateProvider = () => {
    const nextKey = uniqueProviderKey(providerOptions, providerDraft.key || activeProvider);
    const nextDraft = {
      ...providerDraft,
      key: nextKey,
      apiKey: "",
      apiKeyMasked: providerDraft.apiKeyMasked,
      hasStoredApiKey: providerDraft.hasStoredApiKey,
    };
    setProviderCatalog((prev) => ({ ...prev, [nextKey]: nextDraft }));
    syncProviderSelection(nextKey, nextDraft);
    setSaveState(`已基于 ${activeProvider} 复制出 ${nextKey}。`);
  };

  const removeProvider = () => {
    if (providerOptions.length <= 1) return;
    const nextKeys = providerOptions.filter((key) => key !== activeProvider);
    const fallbackKey = nextKeys[0] ?? "openai";
    setProviderCatalog((prev) => {
      const next = { ...prev };
      delete next[activeProvider];
      return next;
    });
    syncProviderSelection(fallbackKey, providerCatalog[fallbackKey]);
    setSaveState(`已从注册表移除 ${activeProvider}，保存后会同步到配置文件。`);
  };

  const resetProviderDraft = () => {
    const nextDraft = settings.providers[activeProvider]
      ? providerDraftFromSettings(settings, activeProvider)
      : createProviderDraft(activeProvider);
    setProviderCatalog((prev) => ({ ...prev, [activeProvider]: nextDraft }));
    setActiveModel(settings.llm.provider === activeProvider ? (settings.llm.model ?? nextDraft.model ?? "") : nextDraft.model);
    setMaxTokens(settings.llm.provider === activeProvider
      ? (settings.llm.maxTokens ? String(settings.llm.maxTokens) : nextDraft.maxTokens)
      : nextDraft.maxTokens);
    setConnectionResult(null);
    setShowApiKey(false);
    setSaveState(`已重置 ${activeProvider} 到最近保存状态。`);
  };

  const clearStoredApiKey = () => {
    patchActiveProvider((prev) => ({
      ...prev,
      apiKey: "",
      apiKeyMasked: "",
      hasStoredApiKey: false,
      apiKeyEnv: "",
    }));
    setConnectionResult(null);
    setSaveState(`已清空 ${activeProvider} 的 Key 来源，保存后生效。`);
  };

  const applyPreset = (draft: ProviderDraft) => {
    const nextKey = providerOptions.includes(draft.key) ? draft.key : uniqueProviderKey(providerOptions, draft.key);
    const nextDraft = { ...draft, key: nextKey };
    setProviderCatalog((prev) => ({ ...prev, [nextKey]: nextDraft }));
    syncProviderSelection(nextKey, nextDraft);
    setSaveState(`已加载 ${nextKey} 预设，保存后写入配置。`);
  };

  const buildConnectionRequest = () => ({
    providerKey: activeProvider || providerDraft.key || "openai",
    provider: {
      ...buildProviderSettings(providerDraft),
      model: (activeModel || providerDraft.model).trim(),
      maxTokens: maxTokens.trim() ? Number.parseInt(maxTokens, 10) : undefined,
    },
  });

  const runConnectionTest = async () => {
    try {
      const result = await requireDesktopBridge().testProviderConnection(buildConnectionRequest());
      setConnectionResult(result);
      return result;
    } catch (error) {
      const fallbackResult: DesktopProviderConnectionResult = {
        ok: false,
        providerKey: activeProvider || "openai",
        providerType: providerDraft.type,
        authSource: providerDraft.authMode === "none" ? "none" : "missing",
        detail: error instanceof Error ? error.message : String(error),
        checkedAt: new Date().toISOString(),
      };
      setConnectionResult(fallbackResult);
      return fallbackResult;
    }
  };

  const save = async () => {
    setSaving(true);
    setTestingConnection(true);
    setConnectionResult(null);
    try {
      const workspaceChanged = fullMode && workspaceRoot.trim() !== (settings.workspaceRoot ?? "");
      const mcpServers = fullMode ? parseMcpServersJson(mcpServersJson) : settings.mcpServers;
      const globalModel = settings.llm.model ?? "";
      const globalMaxTokens = settings.llm.maxTokens ? String(settings.llm.maxTokens) : "";
      const next = {
        ...buildSettings(
          settings,
          providerCatalog,
          fullMode ? workspaceRoot : settings.workspaceRoot,
          fullMode ? activeProvider : (settings.llm.provider ?? "openai"),
          fullMode ? activeModel : globalModel,
          fullMode ? maxTokens : globalMaxTokens,
          fullMode ? toolApprovalMode : (settings.toolApprovalMode ?? "ask"),
          fullMode ? executionPreset : (settings.executionPreset ?? "workspace_write_network"),
        ),
        mcpServers,
      };
      const bridge = requireDesktopBridge();
      const saved = await bridge.saveSettings(next);
      onSaved(saved);
      if (!fullMode && activeSessionId) {
        await bridge.updateSessionLlm({
          sessionId: activeSessionId,
          llm: buildSessionLlmSettings(activeProvider, activeModel, maxTokens),
        });
        await onSessionLlmChanged?.();
      }
      const shouldSyncCurrentSessionWorkspace = fullMode
        && Boolean(activeSessionId)
        && Boolean(saved.workspaceRoot.trim())
        && (workspaceChanged || !sameDisplayPath(currentSessionWorkspaceRoot, saved.workspaceRoot));
      if (shouldSyncCurrentSessionWorkspace && activeSessionId && saved.workspaceRoot.trim()) {
        await bridge.updateSessionWorkspace({ sessionId: activeSessionId, workspaceRoot: saved.workspaceRoot });
        await onSessionWorkspaceChanged?.();
      }
      const testResult = await runConnectionTest();
      setSaveState(`已保存到 ${saved.configPath} · ${testResult.ok ? "连接成功" : "连接失败"}`);
    } catch (error) {
      setSaveState(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
      setTestingConnection(false);
    }
  };

  const testConnection = async () => {
    setTestingConnection(true);
    setConnectionResult(null);
    try {
      await runConnectionTest();
    } finally {
      setTestingConnection(false);
    }
  };

  const connectionLabel = connectionResult ? (connectionResult.ok ? "已连通" : "失败") : providerLabel(providerDraft);
  const activeProviderModelOptions = modelOptionsForProvider(activeProvider, providerDraft);
  const authSummary = providerDraft.authMode === "none"
    ? "当前 provider 不要求 API Key。"
    : providerDraft.apiKey.trim()
      ? "优先使用当前面板里填写的新 API Key。"
      : providerDraft.hasStoredApiKey
        ? `当前已保存 API Key：${providerDraft.apiKeyMasked || "已保存"}。留空即继续使用它。`
        : providerDraft.apiKeyEnv.trim()
          ? `将读取环境变量 ${providerDraft.apiKeyEnv.trim()}。`
          : "还没有可用的 API Key 来源。";
  const connectionFeedbackClass = testingConnection
    ? "testing"
    : connectionResult
      ? (connectionResult.ok ? "success" : "danger")
      : "idle";
  const connectionFeedbackTitle = testingConnection
    ? "正在测试连接"
    : connectionResult
      ? (connectionResult.ok ? "连接成功" : "连接失败")
      : "尚未测试连接";
  const connectionFeedbackDetail = testingConnection
    ? `正在使用 ${activeProvider} / ${activeModel || providerDraft.model || "未设置模型"} 发起测试请求。`
    : connectionResult?.detail ?? authSummary;
  const selectedSavedDraft = settings.providers[activeProvider]
    ? providerDraftFromSettings(settings, activeProvider)
    : createProviderDraft(activeProvider);
  const providerDirty = JSON.stringify(normalizeProviderDraftForCompare(providerDraft)) !== JSON.stringify(normalizeProviderDraftForCompare(selectedSavedDraft));
  const savedRuntimeProvider = fullMode ? (settings.llm.provider ?? "openai") : (currentSessionLlm?.provider ?? settings.llm.provider ?? "openai");
  const savedRuntimeModel = fullMode ? (settings.llm.model ?? "") : (currentSessionLlm?.model ?? settings.llm.model ?? "");
  const savedRuntimeMaxTokens = fullMode
    ? (settings.llm.maxTokens ? String(settings.llm.maxTokens) : "")
    : (currentSessionLlm?.maxTokens ? String(currentSessionLlm.maxTokens) : (settings.llm.maxTokens ? String(settings.llm.maxTokens) : ""));
  const runtimeDirty = activeProvider !== savedRuntimeProvider
    || activeModel.trim() !== savedRuntimeModel
    || maxTokens.trim() !== savedRuntimeMaxTokens
    || (fullMode && workspaceRoot.trim() !== (settings.workspaceRoot ?? ""))
    || (fullMode && toolApprovalMode !== (settings.toolApprovalMode ?? "ask"))
    || (fullMode && mcpServersJson.trim() !== formatMcpServersJson(settings.mcpServers).trim());
  const effectiveModelSource = activeModel.trim()
    ? "当前配置 llm.model"
    : providerDraft.model.trim()
      ? `provider 默认模型 · ${providerDraft.model.trim()}`
      : "未设置";
  const effectiveMaxTokensSource = maxTokens.trim()
    ? "当前配置 llm.maxTokens"
    : providerDraft.maxTokens.trim()
      ? `provider 默认 maxTokens · ${providerDraft.maxTokens.trim()}`
      : "运行时默认值";

  const applyProviderModelOption = (option: ProviderModelOption) => {
    setActiveModel(option.value);
    if (fullMode) {
      patchActiveProvider((prev) => ({ ...prev, model: option.value }));
    }
    setSaveState(fullMode
      ? `已切换到 ${option.label}（${option.value}），保存后作为全局默认生效。`
      : `已切换到 ${option.label}（${option.value}），保存后只对当前会话生效。`);
  };

  const providerDiffItems = [
    { label: "provider 标识", current: activeProvider, saved: selectedSavedDraft.key },
    { label: "协议", current: providerDraft.type, saved: selectedSavedDraft.type },
    { label: "鉴权方式", current: providerDraft.authMode, saved: selectedSavedDraft.authMode },
    { label: "Base URL", current: formatSettingsValue(providerDraft.baseURL), saved: formatSettingsValue(selectedSavedDraft.baseURL) },
    { label: "API Key 来源", current: summarizeApiKeySource(providerDraft), saved: summarizeApiKeySource(selectedSavedDraft) },
    { label: "API Key 环境变量", current: formatSettingsValue(providerDraft.apiKeyEnv), saved: formatSettingsValue(selectedSavedDraft.apiKeyEnv) },
    { label: "默认模型", current: formatSettingsValue(providerDraft.model), saved: formatSettingsValue(selectedSavedDraft.model) },
  ].filter((item) => item.current !== item.saved);
  const runtimeDiffItems = [
    { label: "旧版默认目录", current: formatSettingsValue(workspaceRoot), saved: formatSettingsValue(settings.workspaceRoot) },
    { label: "当前 Provider", current: activeProvider, saved: savedRuntimeProvider },
    { label: "运行模型", current: formatSettingsValue(activeModel), saved: formatSettingsValue(savedRuntimeModel) },
    { label: "运行 maxTokens", current: formatSettingsValue(maxTokens), saved: formatSettingsValue(savedRuntimeMaxTokens) },
    { label: "工具审批", current: toolApprovalModeLabel(toolApprovalMode), saved: toolApprovalModeLabel(settings.toolApprovalMode ?? "ask") },
  ].filter((item) => item.current !== item.saved);
  const visibleRuntimeDiffItems = fullMode ? runtimeDiffItems : runtimeDiffItems.slice(1, 4);

  if (!fullMode) {
    return (
      <div style={{ position: "fixed", inset: 0, background: "rgba(5,8,14,0.58)", backdropFilter: "blur(8px)", zIndex: 20, display: "flex", justifyContent: "flex-end" }}>
        <aside className="panel settings-drawer settings-drawer-model-only">
          <div className="titlebar" style={{ padding: 0, borderBottom: "none" }}>
            <div className="title-group">
              <h2>当前会话模型</h2>
              <p>Provider、模型和 maxTokens 只对当前会话生效；API 连接配置会保存到本机 provider。</p>
            </div>
            <div className="toolbar">
              <ToolBtn onClick={onClose}>关闭</ToolBtn>
              <ToolBtn primary onClick={save}>{saving ? "保存中..." : "保存当前会话"}</ToolBtn>
            </div>
          </div>

          <div className="settings-summary-grid">
            <div className="settings-summary-card">
              <span className="tiny">当前运行</span>
              <strong>{settings.llm.provider || activeProvider}</strong>
              <p className="muted">{settings.llm.model || providerDraft.model || "未固定模型"}</p>
            </div>
            <div className="settings-summary-card">
              <span className="tiny">正在编辑</span>
              <strong>{activeProvider}</strong>
              <p className="muted">{activeModel || providerDraft.model || "未设置模型"}</p>
            </div>
            <div className="settings-summary-card">
              <span className="tiny">连接状态</span>
              <strong>{connectionLabel}</strong>
              <p className="muted">{connectionResult?.detail ?? "保存前可先测试 provider 连接。"}</p>
            </div>
          </div>

          <div className="detail-block settings-section-stack">
            <div className="section-title"><h3>选择 Provider</h3><span className="tiny">{providerOptions.length} 个来源</span></div>
            <div className="provider-registry-grid">
              {providerOptions.map((key) => {
                const draft = providerCatalog[key];
                const selected = key === activeProvider;
                const runtimeActive = key === settings.llm.provider;
                return (
                  <button
                    key={key}
                    className={`provider-registry-item${selected ? " active" : ""}`}
                    type="button"
                    onClick={() => switchProvider(key)}
                  >
                    <div className="provider-registry-head">
                      <strong>{key}</strong>
                      <SignalPill tone={providerTone(draft)}>{providerLabel(draft)}</SignalPill>
                    </div>
                    <p>{draft.model || "未设默认模型"}</p>
                    <div className="provider-meta-row">
                      <span>{draft.type}</span>
                      {runtimeActive ? <span>当前运行</span> : null}
                      {selected ? <span>正在编辑</span> : null}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="detail-block settings-section-stack">
            <div className="section-title"><h3>模型</h3><span className="tiny">{activeProvider}</span></div>
            <div className="settings-inline-grid">
              <div>
                <label className="tiny">Provider</label>
                <select className="settings-input" value={activeProvider} onChange={(e) => switchProvider(e.target.value)}>
                  {providerOptions.map((key) => (
                    <option key={`model-provider-${key}`} value={key}>
                      {key}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="tiny">运行模型</label>
                <input className="settings-input" value={activeModel} onChange={(e) => setActiveModel(e.target.value)} placeholder="deepseek-v4-flash / gpt-5 / openai/gpt-5" />
                {activeProviderModelOptions.length > 0 ? (
                  <div className="provider-action-row provider-action-row-tight model-preset-row">
                    {activeProviderModelOptions.map((option) => (
                      <button
                        key={`model-only-${option.value}`}
                        className={`tool-btn${activeModel.trim() === option.value ? " primary" : ""}`}
                        type="button"
                        title={option.hint}
                        onClick={() => applyProviderModelOption(option)}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
              <div>
                <label className="tiny">最大 Tokens</label>
                <input className="settings-input" value={maxTokens} onChange={(e) => setMaxTokens(e.target.value)} placeholder="4096" />
              </div>
            </div>
            <p className="muted" style={{ margin: 0 }}>{connectionResult?.detail ?? authSummary}</p>
          </div>

          <div className="detail-block settings-section-stack">
            <div className="section-title"><h3>API 设置</h3><span className="tiny">只影响当前 Provider，不修改工作区</span></div>
            <div className="settings-inline-grid">
              <div>
                <label className="tiny">协议</label>
                <select className="settings-input" value={providerDraft.type} onChange={(e) => patchActiveProvider((prev) => ({ ...prev, type: e.target.value as ProviderProtocol }))}>
                  <option value="openai-compatible">openai-compatible</option>
                  <option value="anthropic">anthropic</option>
                  <option value="gemini">gemini</option>
                </select>
              </div>
              <div>
                <label className="tiny">鉴权方式</label>
                <select className="settings-input" value={providerDraft.authMode} onChange={(e) => patchActiveProvider((prev) => ({ ...prev, authMode: e.target.value as ProviderAuthMode }))}>
                  <option value="api_key">api_key</option>
                  <option value="none">none</option>
                </select>
              </div>
            </div>
            <div>
              <label className="tiny">Base URL</label>
              <input className="settings-input" value={providerDraft.baseURL} onChange={(e) => patchActiveProvider((prev) => ({ ...prev, baseURL: e.target.value }))} placeholder="https://api.deepseek.com/v1" />
            </div>
            <div>
              <label className="tiny">API Key</label>
              <div className="settings-inline-grid settings-inline-grid-tight">
                <input
                  className="settings-input"
                  type={showApiKey ? "text" : "password"}
                  value={providerDraft.apiKey}
                  onChange={(e) => patchActiveProvider((prev) => ({
                    ...prev,
                    apiKey: e.target.value,
                    apiKeyMasked: e.target.value.trim() ? "" : prev.apiKeyMasked,
                    hasStoredApiKey: e.target.value.trim() ? false : prev.hasStoredApiKey,
                  }))}
                  placeholder={providerDraft.authMode === "none"
                    ? "可留空"
                    : providerDraft.hasStoredApiKey
                      ? `已保存 ${providerDraft.apiKeyMasked || "API Key"}；留空则保持不变`
                      : "sk-... / 直接填入本地配置"}
                  disabled={providerDraft.authMode === "none"}
                />
                <div className="provider-action-row provider-action-row-tight">
                  <ToolBtn onClick={() => setShowApiKey((value) => !value)}>{showApiKey ? "隐藏" : "显示"}</ToolBtn>
                  <ToolBtn onClick={clearStoredApiKey}>清空来源</ToolBtn>
                </div>
              </div>
            </div>
            <div>
              <label className="tiny">API Key 环境变量</label>
              <input className="settings-input" value={providerDraft.apiKeyEnv} onChange={(e) => patchActiveProvider((prev) => ({ ...prev, apiKeyEnv: e.target.value }))} placeholder={providerDraft.authMode === "none" ? "不需要" : "DEEPSEEK_API_KEY"} disabled={providerDraft.authMode === "none"} />
            </div>
            <div className={`provider-test-panel ${connectionFeedbackClass}`}>
              <div>
                <span className="tiny">连接测试</span>
                <strong>{connectionFeedbackTitle}</strong>
                <p>{connectionFeedbackDetail}</p>
              </div>
              <ToolBtn onClick={() => { void testConnection(); }}>{testingConnection ? "测试中..." : "测试连接"}</ToolBtn>
            </div>
          </div>

          <div className="detail-block settings-section-stack">
            <div className="section-title"><h4>待保存差异</h4><span className="tiny">{providerDiffItems.length + visibleRuntimeDiffItems.length} 项变更</span></div>
            {providerDiffItems.length + visibleRuntimeDiffItems.length > 0 ? (
              <div className="settings-diff-list">
                {visibleRuntimeDiffItems.map((item) => (
                  <div key={`model-runtime-${item.label}`} className="settings-diff-item">
                    <span className="tiny">运行配置 · {item.label}</span>
                    <div className="settings-diff-values">
                      <span>{item.saved}</span>
                      <strong>→</strong>
                      <span>{item.current}</span>
                    </div>
                  </div>
                ))}
                {providerDiffItems.map((item) => (
                  <div key={`model-provider-${item.label}`} className="settings-diff-item">
                    <span className="tiny">Provider · {item.label}</span>
                    <div className="settings-diff-values">
                      <span>{item.saved}</span>
                      <strong>→</strong>
                      <span>{item.current}</span>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="muted">模型配置没有待保存变更。</p>
            )}
            {saveState ? <p className="muted">{saveState}</p> : null}
          </div>
        </aside>
      </div>
    );
  }

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(5,8,14,0.58)", backdropFilter: "blur(8px)", zIndex: 20, display: "flex", justifyContent: "flex-end" }}>
      <aside className="panel settings-drawer settings-drawer-simple">
        <div className="titlebar" style={{ padding: 0, borderBottom: "none" }}>
          <div className="title-group">
            <h2>设置</h2>
            <p>常用项只保留默认工作区、默认模型和 API；Provider/MCP 等放在高级区。</p>
          </div>
          <div className="toolbar">
            <ToolBtn onClick={onClose}>关闭</ToolBtn>
            <ToolBtn primary onClick={save}>{saving ? "保存中..." : "保存"}</ToolBtn>
          </div>
        </div>

        <div className="settings-summary-grid">
          <div className="settings-summary-card">
            <span className="tiny">当前运行 Provider</span>
            <strong>{settings.llm.provider || activeProvider}</strong>
            <p className="muted">运行模型：{settings.llm.model || "未固定"}</p>
          </div>
          <div className="settings-summary-card">
            <span className="tiny">选中条目</span>
            <strong>{activeProvider}</strong>
            <p className="muted">{providerDraft.model || "未设默认模型"}</p>
          </div>
          <div className="settings-summary-card">
            <span className="tiny">注册表规模</span>
            <strong>{providerOptions.length} 个 provider</strong>
            <p className="muted">{providerDirty ? "当前条目有未保存变更" : "当前条目与已保存配置一致"}</p>
          </div>
        </div>

        <details className="settings-advanced">
          <summary>高级 Provider 管理</summary>
          <div className="detail-block settings-section-stack">
            <div className="section-title"><h3>Provider 工作台</h3><span className="tiny">选择、重命名、复制、删除、预设导入</span></div>
          <div className="provider-rename-row">
            <input
              className="settings-input"
              value={providerKeyInput}
              onChange={(e) => setProviderKeyInput(e.target.value)}
              onBlur={renameActiveProvider}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  renameActiveProvider();
                }
              }}
              placeholder="provider 标识"
            />
            <div className="provider-action-row">
              <ToolBtn onClick={renameActiveProvider}>重命名</ToolBtn>
              <ToolBtn onClick={() => moveProvider(-1)}>上移</ToolBtn>
              <ToolBtn onClick={() => moveProvider(1)}>下移</ToolBtn>
              <ToolBtn onClick={addProvider}>新增空白</ToolBtn>
              <ToolBtn onClick={duplicateProvider}>复制当前</ToolBtn>
              <ToolBtn onClick={resetProviderDraft}>恢复已保存</ToolBtn>
              <ToolBtn onClick={resetToPreset}>恢复预设</ToolBtn>
              <ToolBtn onClick={removeProvider}>删除当前</ToolBtn>
            </div>
          </div>
          <div className="provider-registry-grid">
            {providerOptions.map((key) => {
              const draft = providerCatalog[key];
              const selected = key === activeProvider;
              const runtimeActive = key === settings.llm.provider;
              return (
                <button
                  key={key}
                  className={`provider-registry-item${selected ? " active" : ""}`}
                  type="button"
                  onClick={() => switchProvider(key)}
                >
                  <div className="provider-registry-head">
                    <strong>{key}</strong>
                    <SignalPill tone={providerTone(draft)}>{providerLabel(draft)}</SignalPill>
                  </div>
                  <p>{draft.model || "未设默认模型"}</p>
                  <div className="provider-meta-row">
                    <span>{draft.type}</span>
                    <span>{draft.baseURL || "未设 Base URL"}</span>
                    {runtimeActive ? <span>当前运行</span> : null}
                    {selected ? <span>正在编辑</span> : null}
                  </div>
                </button>
              );
            })}
          </div>
          </div>
        </details>

        <div className="detail-block settings-section-stack">
          <div className="section-title"><h3>当前配置</h3><span className="tiny">{settings.configPath}</span></div>
          <div className="settings-inline-grid">
            <div>
              <label className="tiny">旧版默认目录（仅迁移兼容）</label>
              <input className="settings-input" value={workspaceRoot} readOnly />
              <p className="muted">实际修改范围由左侧当前工作区决定，不再由这里统一切换。</p>
            </div>
            <div>
              <label className="tiny">执行权限</label>
              <select className="settings-input" value={executionPreset} onChange={(e) => setExecutionPreset(e.target.value as DesktopSettings["executionPreset"])}>
                <option value="read_only">只读</option>
                <option value="workspace_write">工作区修改（禁网）</option>
                <option value="workspace_write_network">工作区修改 + 联网</option>
                <option value="full_access">完整访问</option>
              </select>
            </div>
            <div>
              <label className="tiny">当前 Provider</label>
              <div className="settings-chip-row">
                <SignalPill tone="accent">{activeProvider}</SignalPill>
                {activeProvider === settings.llm.provider ? <SignalPill tone="success">运行中</SignalPill> : <SignalPill tone="neutral">保存后切换</SignalPill>}
                {activeProvider !== settings.llm.provider ? <ToolBtn onClick={setSelectedAsRuntimeProvider}>设为当前运行</ToolBtn> : null}
              </div>
            </div>
          </div>
          <div className="settings-inline-grid">
            <div>
              <label className="tiny">模型</label>
              <input className="settings-input" value={activeModel} onChange={(e) => setActiveModel(e.target.value)} placeholder="deepseek-v4-flash / gpt-5 / openai/gpt-5" />
              {activeProviderModelOptions.length > 0 ? (
                <div className="provider-action-row provider-action-row-tight model-preset-row">
                  {activeProviderModelOptions.map((option) => (
                    <button
                      key={`runtime-${option.value}`}
                      className={`tool-btn${activeModel.trim() === option.value ? " primary" : ""}`}
                      type="button"
                      title={option.hint}
                      onClick={() => applyProviderModelOption(option)}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
            <div>
              <label className="tiny">最大 Tokens</label>
              <input className="settings-input" value={maxTokens} onChange={(e) => setMaxTokens(e.target.value)} placeholder="4096" />
            </div>
          </div>
          <div className="settings-inline-grid">
            <div>
              <label className="tiny">工具审批</label>
              <select className="settings-input" value={toolApprovalMode} onChange={(e) => setToolApprovalMode(e.target.value as ToolApprovalMode)}>
                <option value="ask">写文件前需要审批</option>
                <option value="workspace_edits">自动批准工作区文件编辑</option>
              </select>
            </div>
            <div>
              <label className="tiny">自动批准范围</label>
              <p className="muted" style={{ margin: 0 }}>
                {toolApprovalMode === "workspace_edits"
                  ? "只自动放行 write_text_file / patch_text_file；终端、删除、移动仍然需要审批。"
                  : "写入、终端、删除、移动等高风险工具都会先生成审批卡片。"}
              </p>
            </div>
          </div>
          <details className="settings-nested-advanced">
            <summary>MCP 工具服务器（高级）</summary>
            <div>
              <textarea
                className="settings-input"
                value={mcpServersJson}
                onChange={(e) => setMcpServersJson(e.target.value)}
                rows={7}
                spellCheck={false}
                style={{ fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace", resize: "vertical" }}
                placeholder={'{\n  "filesystem": {\n    "transport": "stdio",\n    "command": "npx",\n    "args": ["-y", "@modelcontextprotocol/server-filesystem", "G:/projects"]\n  }\n}'}
              />
              <p className="muted" style={{ margin: "8px 0 0" }}>
                配置 stdio MCP server。保存后，新运行会自动通过 tools/list 发现工具，并按读/写/执行风险接入审批。
              </p>
            </div>
          </details>
        </div>

        <div className="detail-block settings-section-stack">
          <div className="section-title"><h3>工作区记忆</h3><ToolBtn onClick={() => { void Promise.all([refreshMemoryCandidates(), refreshWorkspaceMemories()]); }}>刷新</ToolBtn></div>
          <p className="muted" style={{ margin: 0 }}>候选必须确认后才会写入工作区；失效记忆保留审计记录但不会参与后续任务。</p>
          {memoryError ? <p className="muted">{memoryError}</p> : null}
          <MemoryPanel
            candidates={memoryCandidates.map((candidate) => ({ id: candidate.id, summary: candidate.summary }))}
            memories={workspaceMemories.map((memory) => ({ id: memory.id, summary: memory.summary, status: memory.status }))}
            onAccept={(id) => { void decideMemoryCandidate(id, "accept"); }}
            onDismiss={(id) => { void decideMemoryCandidate(id, "dismiss"); }}
            onMarkStale={(id) => { void markWorkspaceMemoryStale(id); }}
            onForget={(id) => { void forgetWorkspaceMemory(id); }}
          />
        </div>

        <div className="detail-block settings-section-stack">
          <div className="section-title">
            <h3>工作区已记住的授权</h3>
            <div className="toolbar">
              <span className="tiny">{reusableApprovals.length} 条</span>
              <ToolBtn onClick={() => { void refreshReusableApprovals(); }}>刷新</ToolBtn>
            </div>
          </div>
          <p className="muted" style={{ margin: 0 }}>这里只显示当前会话工作区内可复用的授权。撤销后，后续同类操作会重新请求确认；高风险操作不会出现在这里。</p>
          {approvalScopeError ? <p className="muted">{approvalScopeError}</p> : null}
          {!activeSessionId ? <p className="muted">先打开一个工作区中的会话，再查看它的授权范围。</p> : null}
          {activeSessionId && reusableApprovals.length === 0 ? <p className="muted">当前工作区没有已记住的授权。</p> : null}
          {reusableApprovals.map((approval) => (
            <div className="settings-diff-item" key={approval.id}>
              <div>
                <span className="tiny">{approval.capability} · 工作区范围</span>
                <div className="settings-diff-values">
                  <span>{approval.pluginId}</span>
                  <strong>·</strong>
                  <span>{approval.decidedAt ? new Date(approval.decidedAt).toLocaleString() : "已授权"}</span>
                </div>
              </div>
              <button className="tool-btn" type="button" onClick={() => { void revokeReusableApproval(approval.id); }} disabled={approvalScopeBusy === approval.id}>
                {approvalScopeBusy === approval.id ? "撤销中…" : "撤销"}
              </button>
            </div>
          ))}
        </div>


        <div className="detail-block settings-section-stack">
          <div className="section-title"><h3>Provider 注册表</h3><span className="tiny">{activeProvider}</span></div>
          <div className="settings-inline-grid">
            <div>
              <label className="tiny">协议</label>
              <select className="settings-input" value={providerDraft.type} onChange={(e) => patchActiveProvider((prev) => ({ ...prev, type: e.target.value as ProviderProtocol }))}>
                <option value="openai-compatible">openai-compatible</option>
                <option value="anthropic">anthropic</option>
                <option value="gemini">gemini</option>
              </select>
            </div>
            <div>
              <label className="tiny">鉴权方式</label>
              <select className="settings-input" value={providerDraft.authMode} onChange={(e) => patchActiveProvider((prev) => ({ ...prev, authMode: e.target.value as ProviderAuthMode }))}>
                <option value="api_key">api_key</option>
                <option value="none">none</option>
              </select>
            </div>
          </div>
          <div>
            <label className="tiny">Base URL</label>
            <input className="settings-input" value={providerDraft.baseURL} onChange={(e) => patchActiveProvider((prev) => ({ ...prev, baseURL: e.target.value }))} placeholder="https://api.deepseek.com/v1" />
          </div>
          <div>
            <label className="tiny">API Key</label>
            <div className="settings-inline-grid settings-inline-grid-tight">
              <input
                className="settings-input"
                type={showApiKey ? "text" : "password"}
                value={providerDraft.apiKey}
                onChange={(e) => patchActiveProvider((prev) => ({
                  ...prev,
                  apiKey: e.target.value,
                  apiKeyMasked: e.target.value.trim() ? "" : prev.apiKeyMasked,
                  hasStoredApiKey: e.target.value.trim() ? false : prev.hasStoredApiKey,
                }))}
                placeholder={providerDraft.authMode === "none"
                  ? "可留空"
                  : providerDraft.hasStoredApiKey
                    ? `已保存 ${providerDraft.apiKeyMasked || "API Key"}；留空则保持不变`
                    : "sk-... / 直接填入本地配置"}
                disabled={providerDraft.authMode === "none"}
              />
              <div className="provider-action-row provider-action-row-tight">
                <ToolBtn onClick={() => setShowApiKey((value) => !value)}>{showApiKey ? "隐藏" : "显示"}</ToolBtn>
                <ToolBtn onClick={clearStoredApiKey}>清空来源</ToolBtn>
              </div>
            </div>
          </div>
          <div className="settings-inline-grid">
            <div>
              <label className="tiny">API Key 环境变量</label>
              <input className="settings-input" value={providerDraft.apiKeyEnv} onChange={(e) => patchActiveProvider((prev) => ({ ...prev, apiKeyEnv: e.target.value }))} placeholder={providerDraft.authMode === "none" ? "不需要" : "DEEPSEEK_API_KEY"} disabled={providerDraft.authMode === "none"} />
            </div>
            <div>
              <label className="tiny">默认模型</label>
              <input className="settings-input" value={providerDraft.model} onChange={(e) => patchActiveProvider((prev) => ({ ...prev, model: e.target.value }))} placeholder="deepseek-v4-flash" />
              {activeProviderModelOptions.length > 0 ? (
                <div className="provider-action-row provider-action-row-tight model-preset-row">
                  {activeProviderModelOptions.map((option) => (
                    <button
                      key={`provider-${option.value}`}
                      className={`tool-btn${providerDraft.model.trim() === option.value ? " primary" : ""}`}
                      type="button"
                      title={option.hint}
                      onClick={() => applyProviderModelOption(option)}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          </div>
          {activeProviderModelOptions.length > 0 ? (
            <p className="muted" style={{ margin: 0 }}>
              DeepSeek 官方新模型为 <code>deepseek-v4-flash</code> 和 <code>deepseek-v4-pro</code>；旧 <code>deepseek-chat</code> / <code>deepseek-reasoner</code> 仅作为兼容入口保留。
            </p>
          ) : null}
          <div>
            <label className="tiny">说明</label>
            <div className="detail-row" style={{ justifyContent: "flex-start" }}>
              <span className="detail-value" style={{ textAlign: "left" }}>{CODEX_PROVIDER_HINT}</span>
            </div>
          </div>
          <div className={`provider-test-panel ${connectionFeedbackClass}`}>
            <div>
              <span className="tiny">连接测试</span>
              <strong>{connectionFeedbackTitle}</strong>
              <p>{connectionFeedbackDetail}</p>
            </div>
            <ToolBtn onClick={() => { void testConnection(); }}>{testingConnection ? "测试中..." : "测试连接"}</ToolBtn>
          </div>
        </div>

        <details className="settings-advanced">
          <summary>高级信息、预设与迁移</summary>
        <div className="detail-block settings-section-stack">
          <div className="section-title"><h4>生效来源</h4><span className="tiny">当前运行到底会吃哪一层配置</span></div>
          <div className="settings-source-grid">
            <div className="settings-source-card">
              <span className="tiny">API Key</span>
              <strong>{summarizeApiKeySource(providerDraft)}</strong>
              <p className="muted">{authSummary}</p>
            </div>
            <div className="settings-source-card">
              <span className="tiny">运行模型</span>
              <strong>{formatSettingsValue(activeModel || providerDraft.model)}</strong>
              <p className="muted">{effectiveModelSource}</p>
            </div>
            <div className="settings-source-card">
              <span className="tiny">maxTokens</span>
              <strong>{formatSettingsValue(maxTokens || providerDraft.maxTokens)}</strong>
              <p className="muted">{effectiveMaxTokensSource}</p>
            </div>
            <div className="settings-source-card">
              <span className="tiny">Base URL</span>
              <strong>{formatSettingsValue(providerDraft.baseURL)}</strong>
              <p className="muted">{providerDraft.baseURL.trim() ? "直接来自 provider 条目" : "未填，依赖 provider/协议默认"}</p>
            </div>
          </div>
        </div>

        <div className="detail-block settings-section-stack">
          <div className="section-title"><h4>待保存差异</h4><span className="tiny">{providerDiffItems.length + visibleRuntimeDiffItems.length} 项变更</span></div>
          {providerDiffItems.length + visibleRuntimeDiffItems.length > 0 ? (
            <div className="settings-diff-list">
              {visibleRuntimeDiffItems.map((item) => (
                <div key={`runtime-${item.label}`} className="settings-diff-item">
                  <span className="tiny">运行配置 · {item.label}</span>
                  <div className="settings-diff-values">
                    <span>{item.saved}</span>
                    <strong>→</strong>
                    <span>{item.current}</span>
                  </div>
                </div>
              ))}
              {providerDiffItems.map((item) => (
                <div key={`provider-${item.label}`} className="settings-diff-item">
                  <span className="tiny">Provider 条目 · {item.label}</span>
                  <div className="settings-diff-values">
                    <span>{item.saved}</span>
                    <strong>→</strong>
                    <span>{item.current}</span>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="muted">当前面板与已保存配置一致，没有待提交差异。</p>
          )}
        </div>

        <div className="detail-block settings-section-stack">
          <h4>快捷预设</h4>
          <div className="provider-preset-grid">
            {PROVIDER_PRESETS.map((preset) => (
              <button key={preset.key} className="tool-btn" type="button" onClick={() => applyPreset(preset)}>{preset.key === "openai" ? "OpenAI API" : preset.key === "codex-api" ? "Codex / OpenAI API" : preset.key === "deepseek" ? "DeepSeek" : preset.key === "openrouter" ? "OpenRouter" : preset.key === "anthropic" ? "Anthropic" : preset.key === "gemini" ? "Gemini" : preset.key === "ollama" ? "Ollama" : preset.key[0].toUpperCase() + preset.key.slice(1)}</button>
            ))}
          </div>
        </div>

        <div className="detail-block settings-section-stack">
          <div className="section-title"><h4>导入 / 导出</h4><span className="tiny">JSON 片段，便于迁移 provider 配置</span></div>
          <div className="provider-action-row">
            <ToolBtn onClick={exportProviderJson}>导出当前 JSON</ToolBtn>
            <ToolBtn onClick={importProviderJson}>导入到当前面板</ToolBtn>
          </div>
          <textarea
            className="settings-textarea"
            value={providerJsonInput}
            onChange={(e) => setProviderJsonInput(e.target.value)}
            placeholder='{"activeProvider":"deepseek","runtime":{"model":"deepseek-chat"},"provider":{"baseURL":"https://api.deepseek.com/v1"}}'
          />
          <p className="muted">导出会带上当前 provider 草稿 + 运行层配置；导入后不会自动保存，需要你再点一次“保存”。</p>
        </div>
        </details>
        {saveState ? <p className="settings-save-state muted">{saveState}</p> : null}
      </aside>
    </div>
  );
}
