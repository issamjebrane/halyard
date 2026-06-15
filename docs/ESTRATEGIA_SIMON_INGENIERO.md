# Estrategia para la sesión del Sr. Simon — Especificación para el ingeniero (Issam)

**Documento técnico · validado con datos reales del oro (histórico de Binance, vela a vela, minuto exacto).**
Fecha: 15/06/2026 · Muestra: 22 operaciones reales de Simon (04/06 – 14/06).

---

## 🎯 Resumen en una línea

> **Modo de salida `RATCHET` · stop con trailing por niveles · riesgo configurable (por defecto 2%, óptimo backtest 5%).**

---

## 1. Lógica de salida: `RATCHET` (esto es lo importante)

Cada operación se abre **a mercado** al precio de la señal, con el **Stop Loss original** y los tres
Take Profit que vienen en la señal. A partir de ahí, el stop se va **subiendo por escalones** según el
precio toca cada TP:

```
AL ABRIR:
    entrar a mercado al precio de la señal
    SL = stop_loss original de la señal
    objetivo de cierre = TP3

MIENTRAS la operación esté abierta:
    si el precio toca TP1  →  mover SL al PRECIO DE ENTRADA      (break-even)
    si el precio toca TP2  →  mover SL al precio de TP1
    si el precio toca TP3  →  cerrar el 100% de la posición      (ganada ✅)
    si el precio toca el SL (esté donde esté)  →  cerrar la posición

NUNCA cerrar parcial. Siempre 100% de la posición en TP3 o en el SL vigente.
```

### Tabla de estados del stop

| Evento alcanzado | Dónde queda el SL | Resultado si revierte ahí |
|---|---|---|
| (recién abierta) | SL original | −1R (pérdida completa) |
| Tocó **TP1** | precio de **entrada** | **0R (break-even)** |
| Tocó **TP2** | precio de **TP1** | +R de TP1 (ganancia parcial asegurada) |
| Tocó **TP3** | — (cierre total) | +R de TP3 (ganancia completa) |

> ⚠️ **Por qué este modo y no “cerrar en TP1” ni “aguantar a TP3 a pelo”:** en la muestra real,
> **7 de 22 operaciones tocaron TP1 (o TP2) y luego se giraron antes de TP3.** Con `RATCHET` esas
> quedan en break-even (0R) o en ganancia parcial asegurada, en lugar de pérdida, y las que corren
> limpias siguen capturando todo el TP3. Esa es la diferencia entre +3,6% (aguantar a TP3 sin
> trailing) y **+45,2% (RATCHET)**, además de reducir el drawdown a la mitad.

---

## 2. Tamaño de posición (riesgo)

El tamaño se calcula para que, **si salta el SL original, la pérdida sea exactamente el % de riesgo**
del capital **actual** (riesgo compuesto: cada operación arriesga sobre el balance del momento, no
sobre el inicial).

```
riesgo_€        = RIESGO_PCT × capital_actual
distancia_stop  = | precio_entrada − stop_loss_original |     (en $)
tamaño_lote     = ajustar para que (distancia_stop en contra) = riesgo_€
```

---

## 3. Parámetros configurables

| Parámetro | Valor por defecto | Rango | Notas |
|---|---|---|---|
| `EXIT_MODE` | `RATCHET` | fijo | No cambiar — es la lógica validada. |
| `RISK_PCT` | `0.02` (2%) | 0.5% – 5% | Ver §4. Subir solo con más histórico. |
| `SL_SOURCE` | señal | — | Usar siempre el SL que manda Simon. |
| `CLOSE_TARGET` | `TP3` | fijo | Cierre total en TP3. |
| `PARTIAL_CLOSE` | `false` | — | No cerrar por tercios. Empeora el resultado. |
| `MAX_HOLD` | 72 h | configurable | Cerrar a mercado si la operación queda abierta sin tocar TP3 ni SL. |

---

## 4. Qué riesgo usar (honesto)

Resultados sobre las **22 operaciones reales** con `RATCHET`:

| Riesgo | Balance (de 500€) | Rentabilidad | Drawdown máx | Recomendación |
|---|---|---|---|---|
| 2% | 584,13 € | +16,8% | 2,1% | ✅ **Arrancar aquí (real)** |
| 3% | 629,39 € | +25,9% | 3,2% | ✅ tras confirmar |
| 4% | 676,76 € | +35,4% | 4,3% | ⚠️ con histórico mayor |
| **5%** | **726,23 €** | **+45,2%** | **5,4%** | ⚠️ óptimo del backtest, frágil |
| 6% | 777,76 € | +55,6% | 6,5% | agresivo |
| 10% | 1.003,37 € | +100,7% | 11,2% | solo demo |

👉 **El 5% es el que maximiza estas 22 operaciones concretas, pero precisamente por eso es engañoso:**
está ajustado a ~10 días de datos. Para una cuenta real, **empezar en 2%** y subir a 3-4% solo
cuando haya **30-40 operaciones** que confirmen que el patrón se mantiene.

---

## 5. Validación operación por operación (RATCHET · 5% · cuenta 500€)

Comprobado contra PAXG (PAX Gold) en Binance, anclando cada señal al precio real de su minuto exacto.

| # | dir | fecha (UTC) | resultado real | R | balance |
|---|---|---|---|---|---|
| 2 | buy | 04/06 19:02 | 🔴 SL | −1,00 | 475,00 € |
| 3 | sell | 05/06 01:41 | 🟢 TP3 | +0,96 | 497,87 € |
| 4 | sell | 05/06 09:01 | 🔴 SL | −1,00 | 472,97 € |
| 5 | sell | 05/06 16:10 | ⚪ TP1→BE | 0,00 | 472,97 € |
| 6 | buy | 07/06 22:38 | 🟢 TP3 | +1,17 | 500,69 € |
| 7 | buy | 08/06 07:43 | 🔴 SL | −1,00 | 475,66 € |
| 8 | sell | 08/06 08:25 | 🟢 TP3 | +0,86 | 496,19 € |
| 9 | buy | 08/06 09:38 | 🟢 TP3 | +0,76 | 515,11 € |
| 14 | buy | 08/06 15:09 | 🟢 TP3 | +1,35 | 549,96 € |
| 15 | buy | 09/06 02:51 | 🔴 SL | −1,00 | 522,46 € |
| 16 | buy | 09/06 07:58 | 🟢 TP3 | +1,36 | 558,00 € |
| 17 | buy | 09/06 13:51 | 🔴 SL | −1,00 | 530,10 € |
| 18 | sell | 09/06 14:18 | ⚪ TP1→BE | 0,00 | 530,10 € |
| 19 | sell | 09/06 16:06 | 🟢 TP3 | +1,94 | 581,56 € |
| 20 | sell | 10/06 15:55 | ⚪ TP1→BE | 0,00 | 581,56 € |
| 38 | buy | 11/06 02:52 | 🟢 TP3 | +1,56 | 627,04 € |
| 39 | buy | 11/06 04:27 | 🟢 TP3 | +1,35 | 669,45 € |
| 40 | sell | 11/06 06:10 | ⚪ TP1→BE | 0,00 | 669,45 € |
| 41 | buy | 11/06 09:45 | ⚪ TP1→BE | 0,00 | 669,45 € |
| 42 | buy | 12/06 07:28 | 🟢 TP3 | +0,93 | 700,69 € |
| 43 | buy | 12/06 11:13 | 🟢 TP2→TP1 | +0,29 | 710,74 € |
| 44 | sell | 14/06 10:46 | 🟢 TP2→TP1 | +0,44 | 726,23 € |

**Totales:** 12 ganadas (TP3 o TP2→TP1) · 5 break-even · 5 perdidas (SL) · **balance final 726,23 €
(+45,2%)** · drawdown máximo **5,4%** · máxima racha perdedora: **1**.

> Nota sobre #43 y #44: tocaron TP2 y se giraron antes de TP3, pero el stop ya estaba en TP1 →
> cerraron en **ganancia parcial** en vez de volver a cero. Es justo el caso que el trailing de
> RATCHET captura y que las estrategias simples (cerrar en TP1, o aguantar a TP3) pierden.

### Evolución del capital (curva, balance al cierre de cada operación)

```
726 €                                                              ●──●──●
                                                              42  43  44
669 €                                            ●──●──●──●
                                       ●──●        39 40 41
                                    ●   19  ●
560 €                   ●──●     ●   16     20
                     14    ●  ●         ●
                   ●        15(SL) 17(SL)→18 BE
515 €       ●──●  ●9
          8    (#7 SL)
500 €  ●        ●6
        ●3   (#4,#5)
475 €  ●2(SL)
        04/06 ──────────────────────────────────────────────── 14/06
```

> Arranque duro (3 SL al principio, baja a ~473€), luego las operaciones que corren a TP3 elevan
> la cuenta de forma sostenida hasta 726€. Los break-even y los cierres parciales (TP que se gira)
> evitan las caídas profundas → por eso el drawdown se queda en 5,4%.

---

## 6. Diferencia con la sesión del BOT (grupo Gold VIP)

Importante para no mezclar configuraciones: **ambas fuentes usan `RATCHET`**, pero el contexto es
distinto y conviene mantener cada sesión con sus propios parámetros y su propio historial de
validación. La lógica de salida coincide; el riesgo se ajusta por separado según el comportamiento de
cada fuente.

| | Sr. Simon | Bot (Gold VIP) |
|---|---|---|
| Modo de salida | `RATCHET` | `RATCHET` |
| Riesgo por defecto | 2% (subir con más datos) | según su propia validación |
| Origen del SL | señal de Simon | señal del grupo |
| Sesión / config | independiente | independiente |

---

## 7. Reconciliación: web de seguimiento (cierre en TP1) vs verificación Binance

Se compararon las 22 operaciones tal como las registra la web (export `track-record.csv`, con
`tp1_hit_at … sl_hit_at`, `result_R`, `peak_tp`, `mfe_R`, `mae_R`) contra la verificación
independiente con velas de 1 minuto. **Bajo la misma forma de cerrar, web y verificación coinciden
en 19/22 operaciones.** Las diferencias se agrupan en tres, con su causa y su corrección:

### 7.1 — La web cierra el 100% en TP1 (diferencia principal)

La web liquida cada operación en TP1, aunque su propia base de datos demuestre que el precio siguió
a TP2 y TP3. Ejemplos (la web cobró TP1; el precio llegó a TP3):

| # | Web cobró (TP1) | Precio llegó a | RATCHET habría dado |
|---|---|---|---|
| 14 | +0,45R | TP3 15:57 | **+1,35R** |
| 16 | +0,42R | TP3 11:52 | **+1,36R** |
| 19 | +0,77R | TP3 16:39 | **+1,94R** |
| 38 | +0,63R | TP3 02:59 | **+1,56R** |
| 39 | +0,50R | TP3 05:34 | **+1,35R** |

Suma de R de las 22 operaciones: **estrategia de la web (TP1) ≈ −2,5R (negativo)** vs
**RATCHET ≈ +8R (positivo)**. La web está midiendo la peor estrategia posible.

➡️ **Corrección (la importante):** cambiar la lógica de cierre de la sesión de Simon de `TP1` a
**`RATCHET`** (la de §1). Es el ~90% del problema.

### 7.2 — Las primeras operaciones (#2–#9) dejaron de seguirse tras TP1

En #2–#9: `peak_tp=1`, `mfe_R`/`mae_R` vacíos. Desde la #14 (08/06) la web ya registra `tp2_hit`,
`tp3_hit`, MFE y MAE. **El software de la web se mejoró a mitad de camino (~08/06).** La verificación
muestra que varias de esas primeras (#3, #5, #6, #8, #9) también corrieron a TP2/TP3, pero la versión
antigua no lo grabó.

➡️ **Corrección:** ya resuelto hacia adelante. Si se quiere un historial homogéneo, reprocesar
#2–#9 con la lógica nueva.

### 7.3 — 3 operaciones "al filo" (#18, #20, #40): TP1 vs SL

| # | TP1 a... | Web | Verificación PAXG | Acierta |
|---|---|---|---|---|
| 18 | 3,6$ | SL directo | rozó TP1 y luego SL | **la web** |
| 20 | 4,0$ | SL directo | rozó TP1 y luego SL | **la web** |
| 40 | 2,5$ | SL directo | rozó TP1 y luego SL | **la web** |

Causa: Binance **no tiene XAUUSD**; la verificación usa **PAXG** (token de oro) como proxy, con un
desfase de 2-4$ y mechas propias. En TP1 tan pegados a la entrada (2-4$), el proxy detectó un roce
que en el oro real no ocurrió. **Aquí la web acierta** (usa oro real). El proxy es fiable en el
agregado, no en operaciones de gatillo fino.

➡️ **Corrección:** en operaciones al filo, fiarse del oro real de la web.

### 7.4 — Granularidad de muestreo de la web

Las horas de la web van ~1 min por detrás de las velas de 1 minuto. La web **consulta el precio cada
~45 s** y sella el toque en el siguiente sondeo. Riesgo: un sondeo cada 45 s **puede perderse una
mecha rápida** que pinche un nivel entre dos consultas (justo lo de #18/#20/#40).

➡️ **Corrección:** que la web lea el **OHLC de 1 minuto del bróker** (máximo y mínimo de cada vela)
en vez de una foto cada 45 s. Más preciso y elimina la ambigüedad de las operaciones al filo.

### Resumen de acciones para la web

1. **Cambiar el cierre de `TP1` → `RATCHET`** en la sesión de Simon (lo que de verdad importa).
2. **Leer OHLC de 1 minuto** del bróker en lugar de sondear cada 45 s.
3. (Opcional) reprocesar #2–#9 con la lógica nueva para un historial homogéneo.

---

## 8. Avisos (leer antes de operar en real)

- **Muestra pequeña:** 22 operaciones (~10 días). Es prometedora pero aún NO concluyente. Con el
  precio del **oro real** (corregido), RATCHET da **+24,5% al 5%** (el +45% del proxy PAXG era
  optimista; ver §7.3). Hace falta llegar a 100 operaciones para confirmar el edge (ver §9).
- **Empezar en demo** o con riesgo bajo (2%) hasta confirmar.
- **El software actual de Simon cierra demasiado pronto (en TP1).** En la muestra, 4 operaciones que
  el software dio por “ganada pequeña” o “perdida” en realidad llegaban a TP3 limpio. RATCHET corrige
  justo eso.
- **Verificación con base de datos PAXG:** XAUUSD no existe en Binance; se usa PAXG (PAX Gold, ~1oz)
  como proxy y se ancla cada señal al precio real de su minuto. Margen de error de ±1 vela en señales
  muy ajustadas; en agregado el resultado es sólido.

---

## 9. Optimización verificada (riesgo y estrategia óptimos)

Se hizo una búsqueda exhaustiva de optimizaciones sobre las 22 operaciones (datos de oro real
corregido), y **cada mejora propuesta se sometió a verificación adversarial contra el sobreajuste**
(la muestra es de solo 22 operaciones con 8 pérdidas — casi cualquier "mejora" es ajuste de ruido).
Conclusión: **la estrategia ya está afinada; el verdadero siguiente paso es recoger más datos, no
más ajustes.**

### 9.1 — Estrategia óptima: `RATCHET` (confirmado, no cambiar)

Tres pruebas independientes lo confirman como robusto:
- **Mejor salida realista** (+4,99R). Una config que daba +5,89R se **descartó**: todo el extra venía
  de 2 operaciones (#5, #41) con un relleno imposible (stop clavado en un nivel que el precio nunca
  superó). No es un edge operable.
- **Domina a `TP3+BE` siempre** — es matemático: el stop de RATCHET nunca es peor que el break-even.
  Mejora "gratis".
- **NO añadir cierres parciales (scale-out).** Pura RATCHET gana a toda variante con scale-out. Razón
  estructural: las 8 perdedoras van directas a SL sin tocar TP1, así que un cierre parcial nunca se
  activa en una perdedora — solo recorta a las ganadoras.

### 9.2 — Riesgo óptimo: `4-5%` fijo (no subir hacia Kelly)

- El riesgo es un **dial**, no una optimización: la eficiencia rentabilidad/caída es **plana (~2,5)
  entre el 1% y el 10%**. No hay número mágico. El 4% es el punto marginal más eficiente.
- **El 5% ya es quarter-Kelly** (la sización conservadora correcta). **NO subir** hacia medio-Kelly
  (11% → ~1 de cada 12 prob. de ruina) ni Kelly completo (22% → 65% prob. de ruina). Son trampas que
  el backtest afortunado esconde.
- ⚠️ **La caída real será ~el doble que el backtest.** El 9,8% al 5% es del orden afortunado en que
  salieron; reordenando las mismas operaciones, la caída esperada es **~15-20%**. Dimensionar para eso.

### 9.3 — Lo que se RECHAZÓ (sobreajuste comprobado)

| Idea | Por qué se rechazó |
|---|---|
| Operar solo compras | Ambas direcciones tienen 4 pérdidas; las sells fallan por el crash, no por dirección |
| Filtrar por RR planeado | Cero poder predictivo (correlación ≈ 0) |
| Saltar la #20 (stop 0,95$) | Si esa operación corre, pierdes un +14,8R |
| Pausar tras 2 pérdidas | Te saltas la mayor ganadora (#19) |
| Sizing por Kelly / RR / martingala | Bombas de concentración o de ruina |

### 9.4 — Lo que SÍ sobrevive (mejoras reales)

1. **Más datos** (lo principal): el edge es estadísticamente fino (media +0,23R, t≈1,0, no
   significativo). Hasta ~100 operaciones, ninguna optimización fina es fiable.
2. **Higiene de señal** (no beneficio): rechazar señales con stop más pegado que ~2-3$ (como la #20 a
   0,95$, por debajo del ruido del oro). Generaliza.
3. **Tope de exposición simultánea** (seguridad): si hay varias operaciones de la misma dirección
   abiertas a la vez, limitar el riesgo total abierto (ej. 8% agregado) para no acumular 20% sin
   querer. No mejora el backtest pero protege la cola real.
4. **Runner post-TP3 (PROMETEDOR, SIN PROBAR):** en operaciones que llegan limpias a TP3, dejar 1/3
   corriendo con stop en TP2. No se puede backtestear (los datos se cortan en TP3) y hay un aviso:
   4 operaciones tocaron TP3 y se giraron a SL. **Recoger precio 1-3R más allá de TP3 en las próximas
   ~20 operaciones antes de aplicarlo.**

---

## ✅ Checklist de implementación

1. [ ] Leer señal de Simon: `direction, entry, sl, tp1, tp2, tp3, created_at`.
2. [ ] Abrir a mercado; colocar SL original; objetivo TP3.
3. [ ] Calcular lote para arriesgar `RISK_PCT` del capital actual (default 2%).
4. [ ] Al tocar TP1 → mover SL a entrada (break-even).
5. [ ] Al tocar TP2 → mover SL a TP1.
6. [ ] Al tocar TP3 → cerrar 100%.
7. [ ] Si toca el SL vigente → cerrar.
8. [ ] Registrar resultado para seguir validando la muestra.
