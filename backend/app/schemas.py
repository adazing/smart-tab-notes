from pydantic import BaseModel, Field


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


class ExplainResponse(BaseModel):
    explanation: str
    used_tab_ids: list[int]
