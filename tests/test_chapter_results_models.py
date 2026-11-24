import pytest
from pydantic import ValidationError

from podcast_mcp.services.document import DeletedChapter, RemovedChapter


def test_chapter_results_forbid_unknown_fields() -> None:
    with pytest.raises(ValidationError):
        RemovedChapter(removed=True, title="A", extra=1)
    with pytest.raises(ValidationError):
        DeletedChapter(deleted=True, time=1.0, title="A", extra=1)
