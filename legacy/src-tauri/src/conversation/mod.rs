pub mod state;

pub use state::{
    add_assistant_message, add_user_message, get_conversation_history, get_conversation_status,
    is_conversation_active, transition_conversation_status, ConversationState,
    Message, Role,
};
