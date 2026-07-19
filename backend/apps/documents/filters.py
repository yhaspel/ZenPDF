import django_filters

from .models import Document


class DocumentFilter(django_filters.FilterSet):
    q = django_filters.CharFilter(field_name="title", lookup_expr="icontains")
    starred = django_filters.BooleanFilter(field_name="starred")
    folder = django_filters.UUIDFilter(field_name="folder")
    trashed = django_filters.BooleanFilter(method="filter_trashed")

    class Meta:
        model = Document
        fields = ["q", "starred", "folder", "trashed"]

    def filter_trashed(self, queryset, name, value):
        if value:
            return queryset.exclude(trashed_at__isnull=True)
        return queryset.filter(trashed_at__isnull=True)
