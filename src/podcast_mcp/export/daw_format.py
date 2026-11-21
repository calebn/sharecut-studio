from enum import StrEnum


class DawFormat(StrEnum):
    RPP = "rpp"
    AAF = "aaf"
    SESX = "sesx"

    @property
    def archive_name(self) -> str:
        return f"session-{self.value}.zip"
