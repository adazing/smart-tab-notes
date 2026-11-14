from pydantic import BaseModel, Field


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
