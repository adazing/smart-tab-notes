from typing import Literal

from pydantic import BaseModel, Field, field_validator, model_validator


# Size caps keep a buggy or hostile client from sending enormous prompts. Text
# is still trimmed to token budgets before it reaches the model.
class TabInput(BaseModel):
    tab_id: int
    title: str = Field(default="", max_length=1_000)
    url: str = Field(default="", max_length=4_096)
    text: str = Field(default="", max_length=300_000)


class ExplainRequest(BaseModel):
    selected_text: str = Field(min_length=1, max_length=20_000)
    page_text: str = Field(default="", max_length=1_000_000)
    other_tabs: list[TabInput] = Field(default_factory=list, max_length=20)
    # The reader's own question about the selection (the toolbar's Ask). When
    # missing or blank, the selection is explained.
    question: str | None = Field(default=None, max_length=2_000)

    @field_validator("question")
    @classmethod
    def blank_question_is_none(cls, question: str | None) -> str | None:
        return question.strip() or None if question is not None else None


class ExplainResponse(BaseModel):
    explanation: str
    used_tab_ids: list[int]


# ---------------------------------------------------------------------------
# /chat
# ---------------------------------------------------------------------------

CHUNK_ID_PATTERN = r"^[A-Za-z0-9_.:-]{1,64}$"


MAX_CHUNKS = 1_500
MAX_CHUNK_CHARS_TOTAL = 3_000_000


class ChatMessage(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(min_length=1, max_length=20_000)


class ChunkInput(BaseModel):
    """One chunk from the extension's getTabContext (TextChunk)."""

    id: str = Field(pattern=CHUNK_ID_PATTERN)
    heading: str = Field(default="", max_length=500)
    text: str = Field(min_length=1, max_length=10_000)


class ChatTab(BaseModel):
    tab_id: int
    title: str = Field(default="", max_length=1_000)
    url: str = Field(default="", max_length=4_096)
    chunks: list[ChunkInput] = Field(min_length=1)


class ChatRequest(BaseModel):
    messages: list[ChatMessage] = Field(min_length=1, max_length=50)
    tabs: list[ChatTab] = Field(min_length=1, max_length=20)

    @field_validator("messages")
    @classmethod
    def last_is_user(cls, messages: list[ChatMessage]) -> list[ChatMessage]:
        if messages[-1].role != "user":
            raise ValueError("the last message must be from the user")
        return messages

    @field_validator("tabs")
    @classmethod
    def unique_chunk_ids(cls, tabs: list[ChatTab]) -> list[ChatTab]:
        ids = [c.id for t in tabs for c in t.chunks]
        if len(ids) != len(set(ids)):
            raise ValueError("chunk ids must be unique across tabs")
        if len(ids) > MAX_CHUNKS:
            raise ValueError(f"at most {MAX_CHUNKS} chunks across all tabs")
        if sum(len(c.text) for t in tabs for c in t.chunks) > MAX_CHUNK_CHARS_TOTAL:
            raise ValueError(f"at most {MAX_CHUNK_CHARS_TOTAL:,} characters of chunk text in total")
        return tabs


class Citation(BaseModel):
    """A source the answer cited, in order of first use. `n` is the chip number."""

    n: int
    chunk_id: str
    tab_id: int
    title: str
    url: str
    heading: str


# ---------------------------------------------------------------------------
# /rank-tabs
# ---------------------------------------------------------------------------


class TabSnippet(BaseModel):
    tab_id: int
    title: str = Field(default="", max_length=1_000)
    url: str = Field(default="", max_length=4_096)
    snippet: str = Field(default="", max_length=4_000)


class RankTabsRequest(BaseModel):
    question: str = Field(min_length=1, max_length=2_000)
    tabs: list[TabSnippet] = Field(min_length=1, max_length=100)


class TabScore(BaseModel):
    tab_id: int
    score: float
    suggested: bool


class RankTabsResponse(BaseModel):
    scores: list[TabScore]


# ---------------------------------------------------------------------------
# /recap
# ---------------------------------------------------------------------------


class RecapNote(BaseModel):
    """One saved note: the highlight, plus whatever the reader added to it."""

    text: str = Field(min_length=1, max_length=20_000)
    note: str = Field(default="", max_length=10_000)
    question: str = Field(default="", max_length=2_000)
    explanation: str = Field(default="", max_length=10_000)


class RecapRequest(BaseModel):
    title: str = Field(default="", max_length=1_000)
    url: str = Field(default="", max_length=4_096)
    # Oldest first, the order the reader made them in.
    notes: list[RecapNote] = Field(default_factory=list, max_length=200)
    chat_summaries: list[str] = Field(default_factory=list, max_length=50)

    @field_validator("chat_summaries")
    @classmethod
    def summaries_fit(cls, summaries: list[str]) -> list[str]:
        kept = [s for s in summaries if s.strip()]
        if any(len(s) > 10_000 for s in kept):
            raise ValueError("each chat summary is at most 10,000 characters")
        return kept

    @model_validator(mode="after")
    def has_something_to_recap(self) -> "RecapRequest":
        if not self.notes and not self.chat_summaries:
            raise ValueError("a recap needs at least one note or chat summary")
        return self


class RecapResponse(BaseModel):
    recap: str
    points: list[str]
