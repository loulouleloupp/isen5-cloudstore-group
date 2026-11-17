# Catalogue : observabilit?

Dashboard : http://localhost:3000/d/catalog-observability (admin/admin en local).

## Objectifs propos?s pour le TP

- P?rim?tre : /products, /inventory/reserve, /inventory/release ; hors healthz et metrics.
- SLI disponibilit? : proportion de r?ponses sans 5xx. Les 4xx de validation/conflit sont des r?ponses attendues.
- SLO disponibilit? : 99,9 % sur 30 jours ; budget de mauvaises requ?tes : 0,1 %.
- SLI latence : proportion de requ?tes termin?es en 200 ms ou moins, tous statuts.
- SLO latence : 99 % sur 30 jours ; budget : 1 %.
- SLA : aucun engagement contractuel pour ce TP. Un SLA r?el doit ?tre convenu avec le client et pr?ciser exclusions et compensations.

Le dashboard et les alertes affichent une fen?tre op?rationnelle de 5 minutes ; elle ne prouve pas le respect du SLO sur 30 jours. Les alertes d?tectent une consommation du budget sup?rieure ? 6 fois le rythme admissible pendant 5 minutes, plus une alerte de cible indisponible pendant 1 minute. Aucun canal externe de notification n'est configur?.

## Corr?lation

Les m?triques OpenMetrics contiennent des exemplaires trace_id ; Grafana les relie ? Jaeger. Les logs JSON contiennent trace_id et span_id, envoy?s par l'instrumentation Pino vers le collector puis Loki. Loki propose un lien TraceID et Jaeger une recherche des logs de la trace. Les identifiants restent hors des labels Prometheus.

Les objectifs sont des propositions p?dagogiques ? ajuster aux besoins du service. Les stockages locaux du Compose ne garantissent pas une conservation de 30 jours ni une conservation apr?s suppression des conteneurs.

## Verification locale

Executer `python3 verify_observability.py` depuis ce dossier, dans WSL. Le script cible explicitement le conteneur pour eviter le processus Node local qui occupe aussi 8082. Il reserve un article puis le libere, et verifie les API de Prometheus, Jaeger, Loki et Grafana.
