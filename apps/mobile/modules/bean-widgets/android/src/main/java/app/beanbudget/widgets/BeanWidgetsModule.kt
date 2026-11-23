package app.beanbudget.widgets

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class BeanWidgetsModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("BeanWidgets")

    Function("takeBudgetShortcut") { pendingBudgetShortcut.getAndSet(null) }

    AsyncFunction("refresh") {
      val context = requireNotNull(appContext.reactContext) { "App context is unavailable" }
      BeanWidgets.refresh(context)
    }
  }
}
