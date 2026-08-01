from django.urls import path

from . import views

urlpatterns = [
    # Folders
    path("folders/", views.FolderListCreateView.as_view(), name="folder-list"),
    path("folders/<uuid:pk>/", views.FolderDetailView.as_view(), name="folder-detail"),
    # Cross-document operations
    path("operations/", views.CrossDocumentOperationView.as_view(), name="cross-operations"),
    # Documents
    path("documents/", views.DocumentListCreateView.as_view(), name="document-list"),
    path("documents/<uuid:pk>/", views.DocumentDetailView.as_view(), name="document-detail"),
    path("documents/<uuid:pk>/restore/", views.DocumentRestoreView.as_view(), name="document-restore"),
    path("documents/<uuid:pk>/content/", views.DocumentContentView.as_view(), name="document-content"),
    path("documents/<uuid:pk>/download/", views.DocumentDownloadView.as_view(), name="document-download"),
    path("documents/<uuid:pk>/pages/<int:n>/thumbnail/", views.ThumbnailView.as_view(), name="document-thumbnail"),
    path("documents/<uuid:pk>/versions/", views.VersionListView.as_view(), name="document-versions"),
    path("documents/<uuid:pk>/versions/<int:seq>/revert/", views.RevertVersionView.as_view(), name="document-revert"),
    path("documents/<uuid:pk>/outline/", views.OutlineView.as_view(), name="document-outline"),
    path("documents/<uuid:pk>/text-search/", views.TextSearchView.as_view(), name="document-text-search"),
    # Phase 3 — annotations read model + the overlay's text layer
    path("documents/<uuid:pk>/annotations/", views.AnnotationListView.as_view(), name="document-annotations"),
    path("documents/<uuid:pk>/text-words/", views.TextWordsView.as_view(), name="document-text-words"),
    # Phase 4 — content read models
    path("documents/<uuid:pk>/text-blocks/", views.TextBlocksView.as_view(), name="document-text-blocks"),
    path("documents/<uuid:pk>/images/", views.PageImagesView.as_view(), name="document-images"),
    path("documents/<uuid:pk>/links/", views.PageLinksView.as_view(), name="document-links"),
    # Phase 5 — forms
    path("documents/<uuid:pk>/form/", views.FormView.as_view(), name="document-form"),
    path("documents/<uuid:pk>/form/export/", views.FormExportView.as_view(), name="document-form-export"),
    path("documents/<uuid:pk>/operations/", views.DocumentOperationView.as_view(), name="document-operations"),
]
