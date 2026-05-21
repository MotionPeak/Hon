import SwiftUI

enum Theme {
    static let bg = Color(red: 0.075, green: 0.070, blue: 0.140)
    static let card = Color(red: 0.130, green: 0.120, blue: 0.220)
    static let cardHigh = Color(red: 0.175, green: 0.160, blue: 0.290)
    static let gold = Color(red: 0.970, green: 0.740, blue: 0.330)
    static let amber = Color(red: 0.980, green: 0.660, blue: 0.200)
    static let green = Color(red: 0.300, green: 0.820, blue: 0.500)
    static let red = Color(red: 0.930, green: 0.370, blue: 0.370)
    static let indigo = Color(red: 0.400, green: 0.340, blue: 0.920)

    static let hairline = Color.white.opacity(0.07)
}

/// Icon + color for each spending category.
enum CategoryStyle {
    static func icon(_ category: String) -> String {
        switch category {
        case "Groceries": return "cart.fill"
        case "Dining": return "fork.knife"
        case "Transport": return "bus.fill"
        case "Fuel": return "fuelpump.fill"
        case "Shopping": return "bag.fill"
        case "Utilities": return "bolt.fill"
        case "Housing": return "house.fill"
        case "Health": return "cross.case.fill"
        case "Entertainment": return "theatermasks.fill"
        case "Subscriptions": return "arrow.triangle.2.circlepath"
        case "Travel": return "airplane"
        case "Education": return "book.fill"
        case "Income": return "arrow.down.circle.fill"
        case "Transfers": return "arrow.left.arrow.right"
        case "Fees": return "percent"
        default: return "circle.grid.2x2.fill"
        }
    }

    static func color(_ category: String) -> Color {
        switch category {
        case "Groceries": return Color(red: 0.36, green: 0.78, blue: 0.45)
        case "Dining": return Color(red: 0.96, green: 0.60, blue: 0.26)
        case "Transport": return Color(red: 0.36, green: 0.62, blue: 0.96)
        case "Fuel": return Color(red: 0.92, green: 0.45, blue: 0.42)
        case "Shopping": return Color(red: 0.85, green: 0.46, blue: 0.84)
        case "Utilities": return Color(red: 0.95, green: 0.78, blue: 0.32)
        case "Housing": return Color(red: 0.40, green: 0.72, blue: 0.74)
        case "Health": return Color(red: 0.93, green: 0.40, blue: 0.50)
        case "Entertainment": return Color(red: 0.66, green: 0.50, blue: 0.93)
        case "Subscriptions": return Color(red: 0.49, green: 0.55, blue: 0.93)
        case "Travel": return Color(red: 0.36, green: 0.78, blue: 0.86)
        case "Education": return Color(red: 0.45, green: 0.70, blue: 0.62)
        case "Income": return Theme.green
        case "Transfers": return Color(red: 0.60, green: 0.62, blue: 0.72)
        case "Fees": return Color(red: 0.70, green: 0.55, blue: 0.50)
        default: return Color(red: 0.55, green: 0.56, blue: 0.66)
        }
    }
}
