#!/usr/bin/env python3
"""Keyword extraction helpers for paper metadata.

This module keeps canonical UI tags for compatibility, then expands paper
metadata with higher-signal compiler/research keywords derived from
title/abstract/venue text.
"""

from __future__ import annotations

from dataclasses import dataclass
import collections
import re
from typing import Iterable


TOKEN_RE = re.compile(r"[a-z0-9][a-z0-9+#-]*")
URL_RE = re.compile(r"https?://\S+", flags=re.IGNORECASE)
WS_RE = re.compile(r"\s+")
PLACEHOLDER_ABSTRACT_RE = re.compile(r"^\s*no abstract available", flags=re.IGNORECASE)
TRAILING_TITLE_ANNOTATION_RE = re.compile(
    r"\s*[【\[][^】\]]{0,140}(?:powered|nict|jst|translation|翻訳|機械翻訳)[^】\]]*[】\]]\s*$",
    flags=re.IGNORECASE,
)
ALNUM_UNICODE_BOUNDARY_RE = re.compile(
    r"(?<=[A-Za-z0-9])(?=[^A-Za-z0-9\s])|(?<=[^A-Za-z0-9\s])(?=[A-Za-z0-9])"
)
PURE_NUMERIC_RE = re.compile(r"^\d+[+]?$")
YEAR_TOKEN_RE = re.compile(r"^(?:19|20)\d{2}$")

MINED_KEYWORDS_LIMIT = 14


STOPWORDS = {
    "a",
    "an",
    "and",
    "are",
    "around",
    "as",
    "at",
    "across",
    "after",
    "among",
    "before",
    "between",
    "be",
    "been",
    "being",
    "but",
    "can",
    "by",
    "during",
    "for",
    "from",
    "has",
    "have",
    "having",
    "in",
    "into",
    "is",
    "it",
    "its",
    "more",
    "not",
    "of",
    "on",
    "over",
    "or",
    "our",
    "such",
    "that",
    "the",
    "their",
    "these",
    "this",
    "those",
    "to",
    "too",
    "under",
    "using",
    "via",
    "was",
    "we",
    "were",
    "which",
    "while",
    "will",
    "would",
    "with",
    "within",
    "without",
    "he",
    "him",
    "his",
    "she",
    "her",
    "they",
    "them",
    "you",
    "your",
    "yours",
    "i",
    "me",
    "my",
    "mine",
    "ours",
    "ourselves",
    "themselves",
    "about",
    "also",
    "both",
    "how",
    "what",
    "toward",
    "towards",
    "now",
    "amongst",
    "into",
    "onto",
    "per",
    "et",
    "al",
    "vs",
    "high",
    "low",
    "end",
    "yet",
}


GENERIC_NOISE = {
    "abstract",
    "algorithm",
    "algorithms",
    "analysis",
    "application",
    "applications",
    "approach",
    "approaches",
    "appendix",
    "available",
    "benchmark",
    "benchmarks",
    "case",
    "cases",
    "code",
    "comparison",
    "data",
    "design",
    "development",
    "different",
    "efficient",
    "effective",
    "better",
    "based",
    "evaluation",
    "example",
    "examples",
    "existing",
    "experimental",
    "experiments",
    "feature",
    "features",
    "first",
    "found",
    "framework",
    "function",
    "functions",
    "general",
    "however",
    "if",
    "improved",
    "improving",
    "include",
    "including",
    "international",
    "implementation",
    "implementations",
    "information",
    "issue",
    "issues",
    "journal",
    "large",
    "lecture",
    "level",
    "many",
    "method",
    "methods",
    "model",
    "models",
    "modern",
    "most",
    "multiple",
    "new",
    "notes",
    "novel",
    "number",
    "only",
    "paper",
    "proceedings",
    "problem",
    "problems",
    "proposed",
    "provides",
    "repository",
    "research",
    "result",
    "results",
    "show",
    "software",
    "source",
    "static",
    "dynamic",
    "study",
    "support",
    "supported",
    "supports",
    "system",
    "systems",
    "technique",
    "techniques",
    "test",
    "than",
    "then",
    "there",
    "through",
    "time",
    "tool",
    "tools",
    "transactions",
    "used",
    "usage",
    "volume",
    "vol",
    "well",
    "when",
    "where",
    "whether",
    "while",
    "widely",
    "workshop",
    "work",
    "powered",
    "translation",
    "translations",
    "jst",
    "nict",
    "global",
    "center",
    "centre",
    "detail",
    "details",
    "overview",
    "introduction",
    "some",
    "other",
    "each",
    "although",
    "able",
    "enable",
    "enables",
    "enabling",
    "made",
    "prior",
}


LOW_SIGNAL_ABSTRACT_MARKERS = (
    "j-global",
    "powered by nict",
    "jst",
    "詳細情報です",
    "科学技術総合リンクセンター",
    "文献「",
    "文献\"",
    "機械翻訳",
)


UNIGRAM_NOISE = {
    "also",
    "both",
    "compiler",
    "compilers",
    "program",
    "programs",
    "language",
    "languages",
    "execution",
    "generation",
    "architecture",
    "architectures",
    "runtime",
    "parallel",
    "computing",
    "machine",
    "instruction",
    "instructions",
    "automatic",
    "intermediate",
    "support",
    "supports",
    "supported",
    "system",
    "systems",
    "software",
    "model",
    "models",
    "result",
    "results",
    "research",
    "code",
    "data",
    "high",
    "low",
    "end",
    "use",
    "uses",
    "used",
    "his",
    "pen",
    "lang",
    "etc",
    "among",
    "across",
}


PHRASE_EDGE_NOISE = {
    "toward",
    "towards",
    "better",
    "beyond",
    "using",
    "based",
    "practical",
    "efficient",
    "effective",
    "safe",
    "novel",
    "new",
    "automatic",
    "appendix",
    "introduction",
    "overview",
    "study",
    "case",
    "cases",
    "how",
    "what",
    "now",
}


TECHNICAL_UNIGRAM_ALLOWLIST = {
    "autotuning",
    "binary",
    "bitcode",
    "compilation",
    "debugging",
    "devirtualization",
    "fuzzing",
    "hardware",
    "instrumentation",
    "interprocedural",
    "kernel",
    "kernels",
    "localization",
    "memory",
    "multithreading",
    "offloading",
    "parallelism",
    "profiling",
    "semantics",
    "verification",
}


TECHNICAL_UNIGRAM_SUFFIXES = (
    "analysis",
    "compiler",
    "compilers",
    "compilation",
    "graph",
    "graphs",
    "inference",
    "instrumentation",
    "ization",
    "isation",
    "kernel",
    "kernels",
    "localization",
    "multithreading",
    "obfuscation",
    "optimization",
    "parallelism",
    "profiling",
    "sanitizer",
    "sanitizers",
    "scheduling",
    "semantics",
    "synthesis",
    "translation",
    "verification",
    "vectorization",
)


FORMAT_TOKEN_MAP = {
    "aot": "AOT",
    "api": "API",
    "arm": "ARM",
    "cfg": "CFG",
    "cfi": "CFI",
    "clang": "Clang",
    "circt": "CIRCT",
    "cpu": "CPU",
    "cuda": "CUDA",
    "cxx": "C++",
    "flang": "Flang",
    "gcc": "GCC",
    "gpu": "GPU",
    "hip": "HIP",
    "hls": "HLS",
    "hpc": "HPC",
    "ir": "IR",
    "isa": "ISA",
    "jit": "JIT",
    "lld": "LLD",
    "lldb": "LLDB",
    "llvm": "LLVM",
    "lto": "LTO",
    "ml": "ML",
    "mlir": "MLIR",
    "mpi": "MPI",
    "opencl": "OpenCL",
    "openmp": "OpenMP",
    "pgo": "PGO",
    "hbm": "HBM",
    "rtl": "RTL",
    "dsl": "DSL",
    "dsls": "DSLs",
    "cgra": "CGRA",
    "cgras": "CGRAs",
    "riscv": "RISC-V",
    "risc-v": "RISC-V",
    "rocm": "ROCm",
    "ssa": "SSA",
    "spirv": "SPIR-V",
    "spir-v": "SPIR-V",
    "svf": "SVF",
    "tsan": "TSan",
    "ubsan": "UBSan",
    "wasm": "WASM",
}


@dataclass(frozen=True)
class AliasRule:
    label: str
    patterns: tuple[str, ...]
    canonical_tag: str = ""


ALIAS_RULES: tuple[AliasRule, ...] = (
    AliasRule("LLVM", (r"\bllvm\b",)),
    AliasRule("Clang", (r"\bclang\b",), "Clang"),
    AliasRule("MLIR", (r"\bmlir\b", r"multi[- ]level intermediate representation"), "MLIR"),
    AliasRule("LLD", (r"\blld\b",), "LLD"),
    AliasRule("LLDB", (r"\blldb\b",), "LLDB"),
    AliasRule("Flang", (r"\bflang\b",), "Flang"),
    AliasRule("CIRCT", (r"\bcirct\b",), "CIRCT"),
    AliasRule("OpenCL", (r"\bopencl\b",), "OpenCL"),
    AliasRule("CUDA", (r"\bcuda\b",), "CUDA"),
    AliasRule("GPU", (r"\bgpu(?:s)?\b", r"graphics processing units?"), "GPU"),
    AliasRule("JIT Compilation", (r"\bjust[- ]in[- ]time\b", r"\bjit\b"), "JIT"),
    AliasRule("Intermediate Representation", (r"\bintermediate representation(?:s)?\b", r"\bllvm ir\b"), "IR"),
    AliasRule("Profile-Guided Optimization", (r"\bprofile[- ]guided optimization\b", r"\bpgo\b"), "PGO"),
    AliasRule("Link-Time Optimization", (r"\blink[- ]time optimization\b", r"\blto\b"), "LTO"),
    AliasRule("Auto-Vectorization", (r"\bauto[- ]?vectori[sz]ation\b", r"\bvectori[sz]ation\b"), "Autovectorization"),
    AliasRule("Loop Optimization", (r"\bloop (?:transformation|optimization|optimi[sz]ation|unrolling|fusion|tiling|interchange)\b",), "Loop transformations"),
    AliasRule("Register Allocation", (r"\bregister allocation\b",)),
    AliasRule("Instruction Selection", (r"\binstruction selection\b",)),
    AliasRule("Instruction Scheduling", (r"\binstruction scheduling\b",)),
    AliasRule("Code Generation", (r"\bcode generation\b",), "Backend"),
    AliasRule("Control Flow Graph", (r"\bcontrol[- ]flow graph\b", r"\bcfg\b")),
    AliasRule("Static Single Assignment", (r"\bstatic single assignment\b", r"\bssa\b")),
    AliasRule("Code Comprehension", (r"\bcode comprehension\b",)),
    AliasRule("Fault Localization", (r"\bfault locali[sz]ation\b",)),
    AliasRule("Program Synthesis", (r"\bprogram synthesis\b",)),
    AliasRule("Type Inference", (r"\btype inference\b",)),
    AliasRule("Alias Analysis", (r"\balias analysis\b",), "Static Analysis"),
    AliasRule("Pointer Analysis", (r"\bpointer analysis\b",), "Static Analysis"),
    AliasRule("Dataflow Analysis", (r"\bdataflow analysis\b", r"\bdata flow analysis\b"), "Static Analysis"),
    AliasRule("Symbolic Execution", (r"\bsymbolic execution\b",), "Dynamic Analysis"),
    AliasRule("Information Flow Tracking", (r"\binformation flow tracking\b", r"\bdynamic information flow\b")),
    AliasRule("Formal Verification", (r"\bformal verification\b",)),
    AliasRule("Model Checking", (r"\bmodel checking\b",)),
    AliasRule("Fuzzing", (r"\bfuzz(?:ing|er|ers)?\b", r"\blibfuzzer\b"), "Testing"),
    AliasRule("Sanitizers", (r"\bsanitizer(?:s)?\b", r"\baddresssanitizer\b", r"\bthreadsanitizer\b", r"\bubsan\b"), "Testing"),
    AliasRule("Memory Safety", (r"\bmemory safety\b",), "Security"),
    AliasRule("Race Detection", (r"\bdata race detection\b", r"\brace detection\b"), "Testing"),
    AliasRule("Devirtualization", (r"\bdevirtuali[sz]ation\b",)),
    AliasRule("Software Watermarking", (r"\bsoftware watermarking\b",)),
    AliasRule("SIMD", (r"\bsimd\b",), "Autovectorization"),
    AliasRule("Offloading", (r"\boffload(?:ing)?\b",), "GPU"),
    AliasRule("Binary Translation", (r"\bbinary translation\b", r"\bdynamic binary translation\b")),
    AliasRule("Reverse Engineering", (r"\breverse engineering\b",)),
    AliasRule("Differential Testing", (r"\bdifferential testing\b",), "Testing"),
    AliasRule("Mutation Testing", (r"\bmutation testing\b",), "Testing"),
    AliasRule("Parallel Computing", (r"\bparallel computing\b", r"\bparallel programming\b")),
    AliasRule("Deterministic Multithreading", (r"\bdeterministic multithreading\b",)),
    AliasRule("Heterogeneous Computing", (r"\bheterogeneous computing\b",)),
    AliasRule("High-Level Synthesis", (r"\bhigh[- ]level synthesis\b",), "Embedded"),
    AliasRule("Quantum Compilation", (r"\bquantum (?:computing|compiler|compilation)\b",), "Quantum Computing"),
)


TAG_ALIASES: dict[str, tuple[str, ...]] = {
    "AI": (r"\bartificial intelligence\b", r"\bai\b"),
    "ML": (r"\bmachine learning\b", r"\bdeep learning\b", r"\bneural network(?:s)?\b"),
    "ClangIR": (r"\bclangir\b", r"\bcir\b"),
    "C++ Libs": (r"\bc\+\+\s+lib(?:rary|raries|s)\b", r"\blibc\+\+\b"),
    "C Libs": (r"\bc\s+lib(?:rary|raries|s)\b", r"\blibc\b"),
    "Debug Information": (r"\bdebug information\b", r"\bdwarf\b"),
    "Infrastructure": (r"\btoolchain\b", r"\binfrastructure\b"),
    "Optimizations": (r"\boptimizations?\b", r"\boptimization pass(?:es)?\b"),
    "Programming Languages": (r"\bprogramming language(?:s)?\b",),
    "Static Analysis": (r"\bstatic analysis\b", r"\bstatic analyzer\b"),
    "Dynamic Analysis": (r"\bdynamic analysis\b",),
}


def collapse_ws(value: str) -> str:
    return WS_RE.sub(" ", value or "").strip()


def _normalize_for_key(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", value.lower())


def _strip_title_annotation(title: str) -> str:
    clean = collapse_ws(title)
    while True:
        next_clean = collapse_ws(TRAILING_TITLE_ANNOTATION_RE.sub("", clean))
        if next_clean == clean:
            return clean
        clean = next_clean


def _is_low_signal_abstract(abstract: str) -> bool:
    if not abstract:
        return False
    lower = abstract.lower()
    marker_hits = sum(1 for marker in LOW_SIGNAL_ABSTRACT_MARKERS if marker in lower or marker in abstract)
    if marker_hits >= 2:
        return True
    if marker_hits >= 1 and len(_tokenize(abstract)) < 24:
        return True
    return False


def _normalize_text_fragment(value: str) -> str:
    text = URL_RE.sub(" ", value or "")
    text = text.replace("\n", " ").replace("\r", " ")
    text = ALNUM_UNICODE_BOUNDARY_RE.sub(" ", text)
    text = re.sub(r"[<>{}\[\]()`\"']", " ", text)
    text = re.sub(r"\b(?:xmlns|mathml|xlink|mml|http|https|www|org)\b", " ", text, flags=re.IGNORECASE)
    return collapse_ws(text).lower()


def _clean_text(title: str, abstract: str, publication: str = "", venue: str = "") -> tuple[str, str, str]:
    abstract_clean = collapse_ws(abstract)
    if PLACEHOLDER_ABSTRACT_RE.match(abstract_clean):
        abstract_clean = ""
    if _is_low_signal_abstract(abstract_clean):
        abstract_clean = ""

    title_clean = _strip_title_annotation(title)
    title_text = _normalize_text_fragment(title_clean)
    abstract_text = _normalize_text_fragment(abstract_clean)
    full_text = " ".join(part for part in [title_text, abstract_text] if part)

    return title_text, abstract_text, full_text


def _tokenize(text: str) -> list[str]:
    return TOKEN_RE.findall(text.lower())


def _token_is_candidate(token: str) -> bool:
    if not token:
        return False
    if token in STOPWORDS or token in GENERIC_NOISE:
        return False
    if PURE_NUMERIC_RE.match(token):
        return False
    if YEAR_TOKEN_RE.match(token):
        return False
    bare = re.sub(r"[^a-z0-9]+", "", token)
    if not bare:
        return False
    if bare.isdigit() or YEAR_TOKEN_RE.match(bare):
        return False
    if len(bare) <= 2 and token not in FORMAT_TOKEN_MAP:
        return False
    return True


def _looks_technical_token(token: str) -> bool:
    if token in FORMAT_TOKEN_MAP:
        return True
    if token in {"llvm", "clang", "mlir", "openmp", "opencl", "cuda", "jit", "lto", "pgo"}:
        return True
    if token in TECHNICAL_UNIGRAM_ALLOWLIST:
        return True
    if re.search(r"[a-z]+\d|\d+[a-z]", token):
        return True
    if "-" in token and len(token) >= 6:
        return True
    return any(token.endswith(suffix) for suffix in TECHNICAL_UNIGRAM_SUFFIXES)


def _phrase_is_low_signal(tokens: list[str]) -> bool:
    if not tokens:
        return True
    if len(tokens) == 1 and len(tokens[0]) <= 3 and tokens[0] not in FORMAT_TOKEN_MAP:
        return True
    if len(tokens) >= 2 and any(tokens[i] == tokens[i - 1] for i in range(1, len(tokens))):
        return True
    if len(tokens) >= 3 and len(set(tokens)) <= len(tokens) - 1:
        return True
    if tokens[0] in PHRASE_EDGE_NOISE or tokens[-1] in PHRASE_EDGE_NOISE:
        return True
    weak = 0
    for token in tokens:
        if token in PHRASE_EDGE_NOISE or token in STOPWORDS:
            weak += 1
    return weak >= len(tokens)


def _format_keyword_phrase(phrase: str) -> str:
    out: list[str] = []
    for token in phrase.split():
        if token in FORMAT_TOKEN_MAP:
            out.append(FORMAT_TOKEN_MAP[token])
        elif token == "c++":
            out.append("C++")
        else:
            out.append(token.capitalize())
    return " ".join(out)


class PaperKeywordExtractor:
    def __init__(self, canonical_tags: Iterable[str]):
        self.canonical_tags = [collapse_ws(str(tag)) for tag in canonical_tags if collapse_ws(str(tag))]
        self._tag_matchers = self._compile_tag_matchers(self.canonical_tags)
        self._alias_rules = self._compile_alias_rules()

    def _compile_tag_matchers(self, canonical_tags: list[str]):
        out: list[tuple[str, re.Pattern[str]]] = []
        for tag in canonical_tags:
            tag_lower = tag.lower()
            patterns = list(TAG_ALIASES.get(tag, ()))
            if not patterns:
                escaped = re.escape(tag_lower)
                if len(re.sub(r"[^a-z0-9]", "", tag_lower)) <= 3:
                    patterns = [rf"(?<![a-z0-9]){escaped}(?![a-z0-9])"]
                else:
                    patterns = [rf"(?<![a-z0-9]){escaped}(?![a-z0-9])"]
            for pattern in patterns:
                out.append((tag, re.compile(pattern, flags=re.IGNORECASE | re.ASCII)))
        return out

    def _compile_alias_rules(self):
        compiled: list[tuple[AliasRule, list[re.Pattern[str]]]] = []
        for rule in ALIAS_RULES:
            patterns = [re.compile(pattern, flags=re.IGNORECASE | re.ASCII) for pattern in rule.patterns]
            compiled.append((rule, patterns))
        return compiled

    def _extract_tags(self, text: str) -> list[str]:
        matched: set[str] = set()
        for tag, pattern in self._tag_matchers:
            if pattern.search(text):
                matched.add(tag)
        return [tag for tag in self.canonical_tags if tag in matched]

    def _extract_alias_keywords(self, text: str) -> tuple[list[str], set[str]]:
        hits: list[str] = []
        tag_hits: set[str] = set()
        for rule, patterns in self._alias_rules:
            if any(pattern.search(text) for pattern in patterns):
                hits.append(rule.label)
                if rule.canonical_tag:
                    tag_hits.add(rule.canonical_tag)
        # preserve declaration order while deduping
        out: list[str] = []
        seen: set[str] = set()
        for label in hits:
            key = _normalize_for_key(label)
            if not key or key in seen:
                continue
            seen.add(key)
            out.append(label)
        return out, tag_hits

    def _extract_mined_keywords(self, title_text: str, abstract_text: str, limit: int = MINED_KEYWORDS_LIMIT) -> list[str]:
        title_tokens = _tokenize(title_text)
        abstract_tokens = _tokenize(abstract_text)
        if not title_tokens and not abstract_tokens:
            return []

        phrase_counts: dict[str, int] = collections.defaultdict(int)
        abstract_phrase_counts: dict[str, int] = collections.defaultdict(int)
        phrase_scores: dict[str, float] = collections.defaultdict(float)
        title_phrases: set[str] = set()

        for n in (1, 2, 3):
            for i in range(max(0, len(title_tokens) - n + 1)):
                chunk = title_tokens[i : i + n]
                if any(not _token_is_candidate(tok) for tok in chunk):
                    continue
                phrase = " ".join(chunk)
                if len(phrase) > 64:
                    continue
                title_phrases.add(phrase)
                phrase_counts[phrase] += 1
                phrase_scores[phrase] += 0.55 + 0.25 * (n - 1)

            for i in range(max(0, len(abstract_tokens) - n + 1)):
                chunk = abstract_tokens[i : i + n]
                if any(not _token_is_candidate(tok) for tok in chunk):
                    continue
                phrase = " ".join(chunk)
                if len(phrase) > 64:
                    continue
                phrase_counts[phrase] += 1
                abstract_phrase_counts[phrase] += 1
                phrase_scores[phrase] += 1.25 + 0.55 * (n - 1)

        for phrase in title_phrases:
            if abstract_phrase_counts.get(phrase, 0) > 0:
                phrase_scores[phrase] += 1.35
            else:
                phrase_scores[phrase] += 0.5

        ranked = sorted(phrase_scores.items(), key=lambda item: (-item[1], item[0]))
        keywords: list[str] = []
        seen_keys: list[str] = []

        for phrase, _score in ranked:
            if phrase in GENERIC_NOISE:
                continue
            phrase_tokens = phrase.split()
            if _phrase_is_low_signal(phrase_tokens):
                continue

            in_title = phrase in title_phrases
            abstract_hits = abstract_phrase_counts.get(phrase, 0)
            total_hits = phrase_counts.get(phrase, 0)

            if not in_title and abstract_hits < 2:
                continue
            if in_title and abstract_hits == 0 and len("".join(phrase_tokens)) < 11:
                continue
            if len(phrase_tokens) == 1:
                token = phrase_tokens[0]
                if token in UNIGRAM_NOISE:
                    continue
                if token.endswith(("ly", "ed", "ing")) and token not in {"fuzzing", "offloading"}:
                    continue
                if not _looks_technical_token(token) and abstract_hits < 2:
                    continue
                if not _looks_technical_token(token) and total_hits < 3:
                    continue
                if not _looks_technical_token(token) and len(token) < 6:
                    continue

            formatted = _format_keyword_phrase(phrase)
            key = _normalize_for_key(formatted)
            if not key:
                continue

            # Avoid near-duplicates while preferring more specific phrases.
            replace_idx = -1
            skip = False
            for idx, prev in enumerate(seen_keys):
                if key == prev:
                    skip = True
                    break
                if key in prev:
                    skip = True
                    break
                if prev in key:
                    replace_idx = idx
            if skip:
                continue

            if replace_idx >= 0:
                keywords[replace_idx] = formatted
                seen_keys[replace_idx] = key
            else:
                keywords.append(formatted)
                seen_keys.append(key)
            if len(keywords) >= limit:
                break

        return keywords

    def extract(self, title: str, abstract: str, publication: str = "", venue: str = "") -> dict[str, list[str]]:
        title_text, abstract_text, full_text = _clean_text(title, abstract, publication=publication, venue=venue)
        meta_text = _normalize_text_fragment(f"{publication} {venue}")
        alias_text = " ".join(part for part in [full_text, meta_text] if part)

        canonical_tags = self._extract_tags(alias_text)
        alias_keywords, alias_tag_hits = self._extract_alias_keywords(alias_text)

        # Add canonical tags implied by alias rules while preserving canonical tag order.
        tag_set = set(canonical_tags)
        tag_set.update(alias_tag_hits)
        tags = [tag for tag in self.canonical_tags if tag in tag_set]

        mined_keywords = self._extract_mined_keywords(title_text, abstract_text)

        keywords: list[str] = []
        seen: list[str] = []

        def add_keyword(value: str):
            key = _normalize_for_key(value)
            if not key:
                return
            for existing in seen:
                if key == existing or key in existing:
                    return
            seen.append(key)
            keywords.append(value)

        for tag in tags:
            add_keyword(tag)
        for kw in alias_keywords:
            add_keyword(kw)
        for kw in mined_keywords:
            add_keyword(kw)

        return {
            "tags": tags,
            "keywords": keywords[:MINED_KEYWORDS_LIMIT],
        }
