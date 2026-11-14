from typing import Literal

from pydantic import BaseModel, Field, field_validator


class TabInput(BaseModel):
    tab_id: int
    title: str = ""
    url: str = ""
    text: str = ""


class ExplainRequest(BaseModel):
    selected_text: str = Field(min_length=1)
    page_text: str = ""
    other_tabs: list[TabInput] = Field(default_factory=list)


class ExplainResponse(BaseModel):
    explanation: str
    used_tab_ids: list[int]


# ---------------------------------------------------------------------------
# /chat
# ---------------------------------------------------------------------------

CHUNK_ID_PATTERN = r"^[A-Za-z0-9_.:-]{1,64}$"


class ChatMessage(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(min_length=1)


class ChunkInput(BaseModel):
    """One chunk from the extension's getTabContext (TextChunk)."""

    id: str = Field(pattern=CHUNK_ID_PATTERN)
    heading: str = ""
    text: str = Field(min_length=1)


class ChatTab(BaseModel):
    tab_id: int
    title: str = ""
    url: str = ""
    chunks: list[ChunkInput] = Field(min_length=1)


class ChatRequest(BaseModel):
    messages: list[ChatMessage] = Field(min_length=1)
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
    title: str = ""
    url: str = ""
    snippet: str = ""


class RankTabsRequest(BaseModel):
    question: str = Field(min_length=1)
    tabs: list[TabSnippet] = Field(min_length=1, max_length=100)


class TabScore(BaseModel):
    tab_id: int
    score: float
    suggested: bool


class RankTabsResponse(BaseModel):
    scores: list[TabScore]
