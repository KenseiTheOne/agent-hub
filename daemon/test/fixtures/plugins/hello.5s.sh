#!/bin/sh
# <agenthub.title>Hello</agenthub.title> <agenthub.version>1.0.0</agenthub.version>
# <agenthub.effects>open.url,open.file</agenthub.effects>
# <agenthub.action id="ping" level="immediate">/bin/echo ping</agenthub.action>
# <agenthub.action id="danger" level="confirm" title="Опасное">/bin/echo danger</agenthub.action>
echo "Hello | status=ok sfimage=star"
echo "---"
echo "Сайт | href=https://example.com/a?b=c"
echo "Открыть | effect='open.url https://example.com'"
echo "Плохо | bash=/bin/rm param1=-rf"
echo "Пинг | action=ping"
echo "Опасно | action=danger"
echo "Прогоны | event=run-blocked"
echo "REASON=$AGENTHUB_REFRESH_REASON"
