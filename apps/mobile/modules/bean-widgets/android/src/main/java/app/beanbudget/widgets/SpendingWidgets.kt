package app.beanbudget.widgets

import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.content.Context
import android.widget.RemoteViews
import java.text.NumberFormat
import java.util.Locale
import kotlin.math.abs
import kotlin.math.roundToInt

private data class DemoSpending(val allotted: Int, val spent: Int)

private object SpendingDemoInputs {
  val daily = DemoSpending(allotted = 3200, spent = 1850)
  val weekly = DemoSpending(allotted = 22400, spent = 9100)
  val pace = 3.0 / 7
}

fun updateSpendingWidgets(context: Context, manager: AppWidgetManager) {
  for ((provider, layout) in listOf(
    SpendingWidgetProvider::class.java to R.layout.bean_spending_square,
    SpendingWideWidgetProvider::class.java to R.layout.bean_spending_wide
  )) {
    val ids = manager.getAppWidgetIds(ComponentName(context, provider))
    if (ids.isEmpty()) continue
    val views = RemoteViews(context.packageName, layout)
    views.setOnClickPendingIntent(R.id.bean_spending_root, BeanWidgets.openApp(context, "register"))
    views.setContentDescription(R.id.bean_spending_root,
      "Demo spending. Hardcoded example values, not your ledger or budget. " +
      "Today ${remainingAmount(SpendingDemoInputs.daily)} remaining. " +
      "This week ${remainingAmount(SpendingDemoInputs.weekly)} remaining. Tap to open the register.")
    setSpending(context, views, SpendingDemoInputs.daily, null, R.id.bean_spending_today_amount, R.id.bean_spending_today_bar)
    setSpending(context, views, SpendingDemoInputs.weekly, SpendingDemoInputs.pace, R.id.bean_spending_week_amount, R.id.bean_spending_week_bar)
    manager.updateAppWidget(ids, views)
  }
}

private fun setSpending(
  context: Context,
  views: RemoteViews,
  spending: DemoSpending,
  pace: Double?,
  amountId: Int,
  barId: Int
) {
  val over = spending.spent > spending.allotted
  views.setTextViewText(amountId, remainingAmount(spending))
  views.setTextColor(amountId, context.getColor(context.resources.getIdentifier(
    "bean_widget_${if (over) "error" else "text"}", "color", context.packageName
  )))
  val ratio = if (spending.allotted == 0) {
    if (spending.spent > 0) 1.0 else 0.0
  } else spending.spent.toDouble() / spending.allotted
  val lit = (minOf(1.0, ratio) * 10).roundToInt()
  val paceSegments = if (pace == null) 0 else (pace * 10).roundToInt()
  val fill = if (if (pace == null) over else ratio > pace) R.drawable.bean_spending_segment_error
    else R.drawable.bean_spending_segment_primary
  views.removeAllViews(barId)
  for (index in 0 until 10) {
    if (index > 0) views.addView(barId, RemoteViews(context.packageName, R.layout.bean_spending_gap))
    val segment = RemoteViews(context.packageName, R.layout.bean_spending_segment)
    segment.setInt(R.id.bean_spending_segment, "setBackgroundResource", when {
      index < lit -> fill
      index < paceSegments -> R.drawable.bean_spending_segment_selected
      else -> R.drawable.bean_spending_segment_outline
    })
    views.addView(barId, segment)
  }
}

private fun remainingAmount(spending: DemoSpending): String {
  val remaining = NumberFormat.getIntegerInstance(Locale.US).format(abs(spending.allotted - spending.spent))
  return (if (spending.spent > spending.allotted) "−" else "") + "¥$remaining"
}

class SpendingWidgetProvider : BeanWidgetProvider()

class SpendingWideWidgetProvider : BeanWidgetProvider()
