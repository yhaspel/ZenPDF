from rest_framework.pagination import LimitOffsetPagination


class DefaultPagination(LimitOffsetPagination):
    """LimitOffset pagination: default 50, max 200 (01-architecture.md §6)."""

    default_limit = 50
    max_limit = 200
