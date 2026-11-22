# Nexarm — Gobernanza de IA sobre ISO 9001, 42001 y 27001

Fecha: 2026-11-10. Punto de partida: [`benchmark-sendpulse/BENCHMARK.md`](benchmark-sendpulse/BENCHMARK.md).
Arquitectura en [`ARQUITECTURA.md`](ARQUITECTURA.md).

## Qué aporta cada norma

| Norma | Pregunta que responde | Papel en Nexarm |
|---|---|---|
| ISO 9001:2015 (calidad) | ¿El servicio sale igual de bien cada vez? | Proceso: requisitos, cambios, no conformidades, mejora |
| ISO/IEC 27001:2022 (seguridad) | ¿Quién accede a qué dato y queda registrado? | Accesos, registros, cifrado, incidentes |
| ISO/IEC 42001:2023 (IA) | ¿Qué puede hacer la IA, con qué riesgo y bajo qué supervisión? | Política de IA, evaluación de impacto, supervisión humana, ciclo de vida del agente |

Las tres comparten estructura (cláusulas 4 a 10), así que se montan como un solo sistema de gestión
integrado: una política, un registro de riesgos, una auditoría interna, una revisión por la dirección.

## Los seis huecos de SendPulse, convertidos en requisitos de Nexarm

| # | Requisito de producto | ISO/IEC 42001 | ISO/IEC 27001 (Anexo A) | ISO 9001 |
|---|---|---|---|---|
| 1 | **Registro de auditoría**: cada llamada MCP guarda agente, usuario, herramienta, datos tocados, resultado y hora. Inalterable y exportable | A.6.2.8 registro de eventos | 8.15 registros, 8.16 seguimiento, 5.33 protección de registros | 7.5 información documentada, 8.5.2 trazabilidad |
| 2 | **Roles por agente**: cada agente tiene identidad propia y permisos mínimos por herramienta y por dato | A.3.2 roles y responsabilidades, A.9.4 uso previsto | 5.15 control de acceso, 5.16 identidad, 5.18 derechos de acceso, 8.2 acceso privilegiado, 5.3 segregación de funciones | 5.3 roles y autoridades |
| 3 | **Aprobación humana forzada por el sistema**: las acciones de riesgo se detienen en el servidor hasta que una persona aprueba | A.9.2 procesos de uso responsable, A.6.2.6 operación y seguimiento | 5.3 segregación de funciones | 8.6 liberación del servicio |
| 4 | **Políticas y límites**: topes de monto, volumen de envíos, horario y tipo de dato, definidos por el cliente y aplicados antes de ejecutar | A.2.2 política de IA, A.9.3 objetivos de uso responsable, 6.1.3 tratamiento de riesgos | 5.12 clasificación, 8.12 prevención de fuga de datos, 5.34 privacidad y datos personales | 8.1 control operacional, 8.2 requisitos del servicio |
| 5 | **Reversión**: toda acción del agente tiene deshacer o compensación, y un botón para suspender al agente | A.6.2.6 operación y seguimiento, A.8.4 comunicación de incidentes | 5.24 a 5.28 gestión de incidentes, 8.13 respaldo | 8.7 salidas no conformes, 10.2 acción correctiva |
| 6 | **Cumplimiento y datos**: dónde se guardan los datos, qué proveedor de modelo los ve, cuánto se retienen | 6.1.4 evaluación de impacto, A.7 datos, A.10.3 proveedores | 5.23 servicios en la nube, 5.31 requisitos legales, 8.10 borrado, 8.24 criptografía | 8.4 proveedores externos |

## Cómo se ve en la arquitectura

Una pasarela de gobernanza entre el cliente de IA y el CRM. Toda llamada MCP pasa por cinco pasos:

1. **Identificar**: qué agente y en nombre de qué usuario.
2. **Autorizar**: rol del agente contra la herramienta y el dato.
3. **Evaluar política**: límites y clasificación del dato.
4. **Aprobar**: si la acción es de riesgo, espera a una persona.
5. **Registrar**: escribe la entrada de auditoría, ejecute o no.

El producto los aplica en siete pasos, con validar y ejecutar por separado: ver
[`nexarm/README.md`](nexarm/README.md#gobernanza).

## Requisitos del sistema de gestión (la empresa, no el producto)

- Política de IA, de seguridad y de calidad firmadas por la dirección (cláusula 5.2 en las tres).
- Registro único de riesgos con evaluación de impacto de IA (42001 6.1.2 y 6.1.4; 27001 6.1.2).
- Declaración de aplicabilidad de controles (27001 6.1.3; 42001 6.1.3).
- Control de cambios del agente: prompts, modelos y herramientas versionados (9001 8.5.6; 27001 8.32; 42001 A.6.2.5).
- Auditoría interna y revisión por la dirección (9.2 y 9.3 en las tres).

## Dos precisiones

- Las normas certifican el sistema de gestión de la empresa, no el software. El copy correcto es
  "diseñado conforme a ISO 42001 y 27001". "Certificado" solo tras auditoría de un organismo acreditado.
- Los números de cláusula y control salen de las ediciones 9001:2015, 27001:2022 y 42001:2023.
  Hay que cotejarlos contra los textos oficiales comprados, y revisar si ya rige la nueva edición de ISO 9001.

## Orden de construcción

1. Registro de auditoría (base de todo lo demás).
2. Identidad y roles por agente.
3. Motor de políticas y límites.
4. Aprobación humana forzada.
5. Reversión y suspensión.
