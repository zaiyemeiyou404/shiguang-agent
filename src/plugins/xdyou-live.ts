const LIBRARY_SEARCH_URL = "https://mfindxidian.libsp.cn/find/unify/search";
const CAMPUS_NETWORK_URL = "https://w.xidian.edu.cn/cgi-bin/rad_user_info";
const REQUEST_TIMEOUT_MS = 8_000;

export async function searchLibrary(query: string, limit: number, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const keyword = query.trim();
  if (!keyword) return { ok: false, error: "Library search needs a query, for example a title, author, or ISBN." };
  throwIfAborted(signal);
  const response = await fetch(LIBRARY_SEARCH_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json;charset=utf-8",
      referer: "https://mfindxidian.libsp.cn/",
      groupCode: "200755",
      jwtOpacAuth: "",
    },
    body: JSON.stringify(librarySearchBody(keyword)),
    signal: AbortSignal.any([AbortSignal.timeout(REQUEST_TIMEOUT_MS), ...(signal ? [signal] : [])]),
  });
  if (!response.ok) return { ok: false, error: `Library search failed (HTTP ${response.status}).` };
  const payload = await response.json() as { data?: { searchResult?: unknown } };
  const rows = Array.isArray(payload.data?.searchResult) ? payload.data.searchResult : [];
  const books = rows.slice(0, Math.max(1, Math.min(limit, 10))).flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const row = item as Record<string, unknown>;
    const title = text(row.title);
    if (!title) return [];
    return [{
      title,
      author: text(row.author),
      publisher: text(row.publisher),
      year: text(row.publishYear ?? row.year),
      isbn: text(row.isbn),
      callNo: firstText(row.callNo),
      available: numberOrNull(row.onShelfCountI ?? row.canBrrowCountI ?? row.onShelfNum),
      total: numberOrNull(row.groupPhysicalCount ?? row.physicalCount),
      recordId: numberOrNull(row.recordId),
    }];
  });
  return { ok: true, dataset: "library", query: keyword, books, count: books.length };
}

export async function queryCampusNetwork(signal?: AbortSignal): Promise<Record<string, unknown>> {
  throwIfAborted(signal);
  const url = new URL(CAMPUS_NETWORK_URL);
  url.searchParams.set("callback", "jsonp");
  url.searchParams.set("_", String(Date.now()));
  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.any([AbortSignal.timeout(REQUEST_TIMEOUT_MS), ...(signal ? [signal] : [])]) });
  } catch {
    return { ok: false, error: "Current campus-network usage is only available while this computer is online through the Xidian network." };
  }
  if (!response.ok) return { ok: false, error: `Campus network query failed (HTTP ${response.status}).` };
  const raw = await response.text();
  const jsonText = raw.trim().replace(/^jsonp\(/, "").replace(/\);?$/, "");
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(jsonText) as Record<string, unknown>;
  } catch {
    return { ok: false, error: "Campus network query returned an unrecognized response." };
  }
  if (typeof payload.error === "string" && payload.error.trim()) {
    return { ok: false, error: "No current campus-network session was found." };
  }
  return {
    ok: true,
    dataset: "network",
    productsName: text(payload.products_name),
    remainBytes: numberOrNull(payload.remain_bytes),
    sumBytes: numberOrNull(payload.sum_bytes),
    onlineDeviceTotal: text(payload.online_device_total),
  };
}

function librarySearchBody(searchWord: string): Record<string, unknown> {
  return {
    docCode: [null],
    litCode: [],
    searchFieldContent: searchWord,
    searchField: "keyWord",
    matchMode: "2",
    resourceType: [],
    subject: [],
    discode1: [],
    publisher: [],
    locationId: [],
    collectionName: [],
    author: [],
    langCode: [],
    countryCode: [],
    publishBegin: null,
    publishEnd: null,
    coreInclude: [],
    ddType: [],
    verifyStatus: [],
    group: [],
    sortField: "relevance",
    sortClause: "desc",
    page: 1,
    rows: 10,
    onlyOnShelf: null,
    campusId: [],
    curLocationId: [],
    eCollectionIds: [],
    kindNo: [],
    libCode: [],
    neweCollectionIds: [],
    newCoreInclude: [],
    customSub: [],
    customSub0: [],
    searchItems: null,
    indexSearch: 1,
  };
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function firstText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) return text(value[0]);
  return "";
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Run cancelled", "AbortError");
}
