"""Engine error taxonomy → job error codes (01-architecture.md §11).

Engine functions are pure (bytes+params → bytes) and raise these; the worker
maps `.code` onto the Job.error_code and the API error shape (§6).
"""


class EngineError(Exception):
    """Base engine error. `code` is a stable machine string."""

    code = "engine_error"

    def __init__(self, message: str = "", *, details: dict | None = None):
        super().__init__(message or self.__doc__ or self.code)
        self.message = message or (self.__doc__ or self.code)
        self.details = details or {}


class InvalidParams(EngineError):
    code = "validation_error"


class PageOutOfRange(InvalidParams):
    code = "validation_error"


class WouldDeleteAllPages(InvalidParams):
    code = "validation_error"


class DocumentEncryptedError(EngineError):
    code = "document_encrypted"


class UnsupportedFileError(EngineError):
    code = "unsupported_file"


class EngineTimeout(EngineError):
    code = "engine_timeout"
