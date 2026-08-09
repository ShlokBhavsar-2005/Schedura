import time
from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC

print("=========================================")
print("Starting 10 Selenium Login Test Cases...")
print("Make sure your Node.js server is running on port 5000!")
print("Have your screenshot tool ready.")
print("=========================================\n")

options = webdriver.ChromeOptions()
options.add_experimental_option('excludeSwitches', ['enable-logging'])
options.add_argument('--start-maximized')
driver = webdriver.Chrome(options=options)

test_cases = [
    {
        "id": 1,
        "name": "Empty Fields Validation",
        "email": "",
        "password": ""
    },
    {
        "id": 2,
        "name": "Invalid Domain Validation (Gmail)",
        "email": "student@gmail.com",
        "password": "mypassword123"
    },
    {
        "id": 3,
        "name": "Missing Password Validation",
        "email": "test@diu.iiitvadodara.ac.in",
        "password": ""
    },
    {
        "id": 4,
        "name": "Incorrect Password Error",
        "email": "test@diu.iiitvadodara.ac.in",
        "password": "wrongpassword_123"
    },
    {
        "id": 5,
        "name": "Unregistered / Non-existent User Error",
        "email": "ghost@diu.iiitvadodara.ac.in",
        "password": "mypassword123"
    },
    {
        "id": 6,
        "name": "SQL Injection Attempt in Email",
        "email": "admin' OR 1=1--@diu.iiitvadodara.ac.in",
        "password": "mypassword"
    },
    {
        "id": 7,
        "name": "XSS Attempt in Email",
        "email": "<script>alert(1)</script>@diu.iiitvadodara.ac.in",
        "password": "hello"
    },
    {
        "id": 8,
        "name": "Excessive Email Length Handling",
        "email": "a" * 150 + "@diu.iiitvadodara.ac.in",
        "password": "hello"
    },
    {
        "id": 9,
        "name": "Password Visibility Toggle Test",
        "email": "test@diu.iiitvadodara.ac.in",
        "password": "mypassword123",
        "toggle_password": True
    },
    {
        "id": 10,
        "name": "Successful Valid Login Test",
        "email": "test@diu.iiitvadodara.ac.in",
        "password": "mypassword123"
    }
]

try:
    wait = WebDriverWait(driver, 10)
    
    for tc in test_cases:
        print(f"\n---> Running Test Case {tc['id']}/10: {tc['name']} <---")
        
        # Navigate and clear session storage
        driver.get('http://localhost:5000/login.html')
        driver.execute_script("sessionStorage.clear();")
        driver.get('http://localhost:5000/login.html')
        time.sleep(0.5)
        
        # Elements
        email_input = wait.until(EC.presence_of_element_located((By.ID, 'emailInput')))
        password_input = driver.find_element(By.ID, 'passwordInput')
        login_btn = driver.find_element(By.ID, 'loginBtn')
        
        # Fill Form
        if tc["email"]:
            email_input.send_keys(tc["email"])
        if tc["password"]:
            password_input.send_keys(tc["password"])
            
        # Special Logic for Toggle Password UI Test
        if tc.get("toggle_password"):
            toggle_pw_btn = driver.find_element(By.CLASS_NAME, 'toggle-pw')
            toggle_pw_btn.click()
            print(f"⏳ Pausing 5 secs for Screenshot {tc['id']} (UI showing revealed password)...")
            time.sleep(5)
            continue # Move to next test without clicking login
            
        # Submit
        login_btn.click()
        
        # Wait for outcome
        try:
            alert_box = wait.until(EC.visibility_of_element_located((By.ID, 'alertBox')))
            time.sleep(0.5) 
            print(f"Alert generated: '{alert_box.text}'")
        except Exception:
            print("No alert box appeared in time.")
            
        print(f"⏳ Pausing 5 secs for Screenshot {tc['id']} (Capture the result/alert)...")
        time.sleep(5)

    print("\n✅ All 10 tests completed successfully!")
    
except Exception as e:
    print(f"\n❌ An error occurred: {e}")

finally:
    print("\nClosing browser...")
    driver.quit()
